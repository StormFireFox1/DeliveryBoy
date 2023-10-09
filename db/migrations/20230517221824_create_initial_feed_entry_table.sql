-- Add migration script here
CREATE TABLE IF NOT EXISTS feed_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL, 
    link TEXT NOT NULL,
    title TEXT NOT NULL,
    feed TEXT NOT NULL
);