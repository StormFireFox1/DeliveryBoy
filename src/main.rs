use axum::{
    extract::TypedHeader,
    headers::authorization::{Authorization, Bearer},
    http::Request,
    http::StatusCode,
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Extension, Json, Router,
};
use chrono::{DateTime, Datelike, TimeZone, Utc};
use chrono_tz::US::Pacific;
use clokwerk::{AsyncScheduler, Job};
use serde::{Deserialize, Serialize};
use serenity::model::channel::Embed;
use serenity::{http::Http, json::Value, model::webhook::Webhook};
use sqlx::migrate::MigrateDatabase;
use sqlx::{Sqlite, SqlitePool};

use std::{env, time::Duration};
use std::net::SocketAddr;
use std::sync::Arc;

use tower::ServiceBuilder;
use tower_http::trace;
use tower_http::trace::TraceLayer;
use tracing::Level;
use url::Url;

struct DeliveryBoyState {
    key: String,
    webhook_urls: String,
    database: SqlitePool,
}

#[derive(Deserialize, Serialize)]
struct FeedEntry {
    link: Url,
    date: DateTime<Utc>,
    title: String,
    feed: String,
}

#[derive(Serialize, Deserialize)]
struct EntryIngestRequest {
    link: String,
    title: String,
    feed: String,
}

async fn auth<B>(
    TypedHeader(auth): TypedHeader<Authorization<Bearer>>,
    state: Extension<Arc<DeliveryBoyState>>,
    request: Request<B>,
    next: Next<B>,
) -> Result<Response, StatusCode> {
    if auth.token() == state.key {
        let response = next.run(request).await;
        Ok(response)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

async fn add_feed_entry(
    state: Extension<Arc<DeliveryBoyState>>,
    request: Json<EntryIngestRequest>,
) -> Result<&'static str, StatusCode> {
    let entry_url = match Url::parse(request.link.as_str()) {
        Ok(url) => url,
        Err(_) => return Err(StatusCode::BAD_REQUEST),
    };
    let entry = FeedEntry {
        link: entry_url,
        date: Utc::now(),
        title: request.title.clone(),
        feed: request.feed.clone(),
    };
    let url_string = entry.link.as_str();
    let date_string = entry.date.format("%Y-%m-%dT%H:%M:%S").to_string();

    match sqlx::query!(
        r#"
        INSERT INTO feed_entry (timestamp, link, title, feed)
        VALUES ($1, $2, $3, $4)
        "#,
        date_string,
        url_string,
        entry.title,
        entry.feed,
    )
    .execute(&state.database)
    .await
    {
        Ok(_) => Ok("Added feed entry!"),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn get_feed_entries(
    state: Extension<Arc<DeliveryBoyState>>,
) -> Result<Json<Vec<FeedEntry>>, StatusCode> {
    let mut entries: Vec<FeedEntry> = Vec::new();
    match sqlx::query!(
        r#"
        SELECT *
        FROM feed_entry
        WHERE timestamp > datetime('now', 'weekday 0', '-7 days');
        "#
    )
    .fetch_all(&state.database)
    .await
    {
        Ok(records) => {
            for record in records {
                let date =
                    match Utc.datetime_from_str(record.timestamp.as_str(), "%Y-%m-%dT%H:%M:%S") {
                        Ok(date) => date,
                        Err(e) => {
                            tracing::error!("Could not parse date: {}", e);
                            return Err(StatusCode::INTERNAL_SERVER_ERROR);
                        }
                    };
                entries.push(FeedEntry {
                    link: Url::parse(record.link.as_str()).expect(
                        "URL should be valid, since we validated it on adding to database.",
                    ),
                    date,
                    title: record.title,
                    feed: record.feed,
                });
            }
            Ok(Json(entries))
        }
        Err(e) => {
            tracing::error!("Could not fetch entries from database: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn post_digest(state: Extension<Arc<DeliveryBoyState>>) -> Result<&'static str, StatusCode> {
    let mut entries: Vec<FeedEntry> = Vec::new();
    match sqlx::query!(
        r#"
        SELECT *
        FROM feed_entry
        WHERE timestamp > datetime('now', 'weekday 0', '-7 days');
        "#
    )
    .fetch_all(&state.database)
    .await
    {
        Ok(records) => {
            for record in records {
                let date =
                    match Utc.datetime_from_str(record.timestamp.as_str(), "%Y-%m-%dT%H:%M:%S") {
                        Ok(date) => date,
                        Err(e) => {
                            tracing::error!("Could not parse date: {}", e);
                            return Err(StatusCode::INTERNAL_SERVER_ERROR);
                        }
                    };
                entries.push(FeedEntry {
                    link: Url::parse(record.link.as_str()).expect(
                        "URL should be valid, since we validated it on adding to database.",
                    ),
                    date,
                    title: record.title,
                    feed: record.feed,
                });
            }

            // First check if we even have any articles to deliver.
            if entries.is_empty() {
                let embed = Embed::fake(|e| {
                    e.title("Nothing this week! 😅")
                        .description("Here are the articles from the past week!")
                        .color(0x5865F2)
                        .footer(|f| {
                            f.text(
                                "Disclaimer: It's possible I missed all of Matei's messages. Oops.",
                            )
                        })
                });

                match send_webhook(&state.webhook_urls, embed).await {
                    Ok(_) => (),
                    Err(e) => {
                        tracing::error!("Could not send webhook: {}", e);
                        return Err(StatusCode::INTERNAL_SERVER_ERROR);
                    }
                }

                return Ok("Done!");
            }

            // If not, just get all the descriptions for each entry written out.
            let mut description = String::new();
            for (i, entry) in entries.iter().enumerate() {
                description.push_str(
                    format!(
                        "**{}.** [{}]({})\n_Feed:_ {}\n",
                        i + 1,
                        entry.title,
                        entry.link,
                        entry.feed
                    )
                    .as_str(),
                );
            }

            let embed = Embed::fake(|e| {
                e.title(format!(
                    "Posts for Week {}",
                    chrono::Local::now().iso_week().week()
                ))
                .color(0x5865F2)
                .description(description.trim_end())
                .footer(|f| {
                    f.text("Disclaimer: This is not sorted in any particular order of interest.")
                })
            });

            match send_webhook(&state.webhook_urls, embed).await {
                Ok(_) => Ok("Done!"),
                Err(e) => {
                    tracing::error!("Could not send webhook: {}", e);
                    Err(StatusCode::INTERNAL_SERVER_ERROR)
                }
            }
        }
        Err(e) => {
            tracing::error!("Could not fetch entries from database: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn send_webhook(webhook_urls: &str, embed: Value) -> Result<(), String> {
    let urls = webhook_urls.split(',');
    let http = Http::new("token");
    for url in urls {
        let webhook = Webhook::from_url(&http, url).await;
        match webhook {
            Ok(webhook) => {
                match webhook
                    .execute(&http, false, |w| {
                        w.username("Delivery Boy").embeds(vec![embed.clone()])
                    })
                    .await
                {
                    Ok(_) => tracing::info!("Sent webhook to {}", url),
                    Err(e) => {
                        tracing::error!("Could not send webhook: {}", e);
                        return Err(e.to_string());
                    }
                }
            }
            Err(e) => {
                tracing::error!("Could not get webhook: {}", e);
                return Err(e.to_string());
            }
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv::dotenv().ok();
    tracing_subscriber::fmt()
        .with_target(false)
        .with_max_level(Level::INFO)
        .compact()
        .init();

    let db_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    if !Sqlite::database_exists(&db_url).await.unwrap_or(false) {
        Sqlite::create_database(&db_url)
            .await
            .expect("Could not create database!");
        let pool = SqlitePool::connect(&db_url)
            .await
            .expect("Could not connect to database!");
        // Run migrations to get database up to date.
        // Should update schema.
        sqlx::migrate!("db/migrations").run(&pool).await?;
    }

    let pool = SqlitePool::connect(&db_url)
        .await
        .expect("Could not connect to database!");

    // Setup local state to share with webserver.
    let webhook_urls: String =
        env::var("DISCORD_WEBHOOK_URL").expect("Missing Discord webhook URLs!");
    let key: String = env::var("KEY").expect("Missing authorization key in Delivery Boy!");
    let state = Arc::new(DeliveryBoyState {
        key,
        webhook_urls,
        database: pool,
    });
    // Save key for use in cron job later.

    // Setup routes for web server.
    // Also setup logging as middleware.
    let app = Router::new()
        .route("/ingest", get(get_feed_entries).put(add_feed_entry))
        .route("/ingest", post(post_digest))
        .layer(middleware::from_fn(auth))
        .layer(Extension(state))
        .layer(
            ServiceBuilder::new().layer(
                TraceLayer::new_for_http()
                    .make_span_with(trace::DefaultMakeSpan::new().level(Level::INFO))
                    .on_response(trace::DefaultOnResponse::new().level(Level::INFO)),
            ),
        );

    // Delivery Boy posts the feed entries every week on Saturday at 10 AM.
    // This cronjob should do it.

    let cronjob_fn = || async {
        // ping local webserver to send digest.
        let key: String = env::var("KEY").expect("Missing authorization key in Delivery Boy!");
        let client = reqwest::Client::new();
        match client
            .post("http://localhost:8080/ingest")
            .bearer_auth(key)
            .send()
            .await
        {
            Ok(_) => tracing::info!("Cron job run successfuly!"),
            Err(e) => tracing::error!("Could not send request to local webserver: {}", e),
        }
    };
    
    let mut scheduler = AsyncScheduler::with_tz(Pacific);
    scheduler
        .every(clokwerk::Interval::Sunday)
        .at("10:00 am")
        .run(cronjob_fn);
    
    tokio::spawn(async move {
        loop {
          scheduler.run_pending().await;
          tokio::time::sleep(Duration::from_millis(1000)).await;
        }
     });

    // Start up web server.
    let addr = SocketAddr::from(([0, 0, 0, 0], 8080));
    tracing::info!("Listening on {addr}");
    axum::Server::bind(&addr)
        .serve(app.into_make_service())
        .await
        .expect("Failed to start server");
    Ok(())
}
