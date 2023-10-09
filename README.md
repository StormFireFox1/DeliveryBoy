# Delivery Boy

A little web app that sends a formatted embed of RSS articles to a Discord webhook.

## Usage:

Fill `.env.example` into `.env` and:

```
cargo run
```

Then, whenever you want to add a feed for the next ingest to send, send a `PUT` request at `/ingest` with the following JSON body:
```json
{
    "title": "Title of Article",
    "link": "Link to Article",
    "feed": "RSS feed article came from"
}
```

You'll also need to set the HTTP header `Authorization: Bearer $KEY`, where `$KEY` is the key you used in `.env`.

The other routes include:
`GET /ingest` - Gets the next saved ingest.
`POST /ingest` - Manually send the next ingest right now. This does not change the scheduled ingest.

Note all routes need authentication.
