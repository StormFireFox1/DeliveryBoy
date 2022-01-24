import { config } from 'dotenv';
import express from 'express';
import Logger from './utils/Logger';
import { DateTime } from 'luxon';
import { scheduleJob, RecurrenceRule } from 'node-schedule';
import bodyParser from 'body-parser';
import { MessageEmbed, WebhookClient } from 'discord.js';

config();

const entryStorage: Record<string, FeedEntry[]> = {};

const app = express();
app.use(bodyParser.json());

const timeToSendIngest = new RecurrenceRule();
timeToSendIngest.tz = "America/Los_Angeles";
timeToSendIngest.minute = 0;
timeToSendIngest.second = 0;
timeToSendIngest.hour = 10;

/**
 * Cronjob to run Notion Event Sync Pipeline every 30 minutes.
 */
scheduleJob(timeToSendIngest, async () => {
    Logger.info('Sending feed for the day!');
    const webhook = new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL });
    const today = DateTime.now().setZone("America/Los_Angeles");
    const date = today.toFormat("LLL dd, yyyy");
    const digest = entryStorage[date];
    let embedText = "";
    digest.forEach((entry, index) => {
        embedText += `**${index + 1}** _${entry.title}_: ${entry.link}`
        embedText += `_Feed:_ \`${entry.feed}\``
        embedText += "\n";
    })
    embedText = embedText.substring(0, embedText.length - 1);
    const webhookEmbed = new MessageEmbed()
    .setTitle(`Posts for ${date}`)
    .setColor('BLUE')
    .setDescription(embedText)
    .setFooter({
        text: "Disclaimer: This is not sorted in any particular order of interest."
    });
    await webhook.send({
        embeds: [webhookEmbed],
    });
});

export interface FeedEntry {
    link: string;
    feed: string;
    title: string;
};

/**
 * Route to trigger sync manually. Does not disrupt cronjob.
 */
app.post('/ingest', async (req, res) => {
    try {
        let feedEntry: FeedEntry;
        feedEntry = req.body;
        let timeForDigest = DateTime.now().setZone("America/Los_Angeles");
        if (timeForDigest.hour > 10) {
            timeForDigest = timeForDigest.plus({days: 1});
        }
        const date = timeForDigest.toFormat("LLL dd, yyyy");
    
        if (!entryStorage[date]) {
            entryStorage[date] = [];
        } 
        entryStorage[date].push(feedEntry);
        res.send('Saved feed entry!');
    } catch (e) {
        res.status(400).send(`Cannot parse feed JSON: ${e}`);
    }
});

if (!process.env.DISCORD_WEBHOOK_URL) {
    Logger.error("Cannot run! Need Discord webhook URL!");
}
Logger.info('Ready. Listening on port 8099!');
app.listen(8099, 'localhost');