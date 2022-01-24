# Delivery Boy

A little web app that sends a formatted embed of RSS articles to a Discord webhook.

## Usage:

Fill `.env.example` into `.env and:

```sh
yarn install
yarn start
```

Then, whenever you want to add a feed for the next ingest to send, send a `POST` request at `/ingest` with the following JSON body:
```json
{
    "title": "Title of Article",
    "link": "Link to Article",
    "feed": "RSS feed article came from"
}
```