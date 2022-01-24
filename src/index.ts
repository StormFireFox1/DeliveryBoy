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

const sendIngest = async () => {
    Logger.info('Sending feed for the day!');
    const webhook = new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL });
    const today = DateTime.now().setZone("America/Los_Angeles");
    const date = today.toFormat("LLL dd, yyyy");
    const digest = entryStorage[date];
    let embedText = "";
    if (!digest || digest.length === 0) {
        const webhookEmbed = new MessageEmbed()
            .setTitle(`Nothing today! Sorry! 😅`)
            .setColor('RED')
            .setDescription("Matei be slacking today smh")
            .setFooter({
                text: "Disclaimer: It's possible I missed all of Matei's messages. Oops.",
            });
            await webhook.send({
                embeds: [webhookEmbed],
            });
    } else {
        digest.forEach((entry, index) => {
            embedText += `**${index + 1}.** _${entry.title}_: ${entry.link}`
            embedText += "\n";
            embedText += `_Feed:_ \`${entry.feed}\``
            embedText += "\n";
        })
        if (digest.length < 5) {
            embedText += "\n";
            embedText += "Matei was quite lazy today. He didn't send 5 articles! 🙄";
            embedText += "\n";
        } else if (digest.length > 5) {
            embedText += "\n";
            embedText += "Sorry for the amount! Just a few more!";
            embedText += "\n";
        }
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
    }
    Logger.info("Done with sending ingest!");
    return "Done!";
};

/**
 * Cronjob to run Notion Event Sync Pipeline every 30 minutes.
 */
scheduleJob(timeToSendIngest, async () => {
    sendIngest();
});

export interface FeedEntry {
    link: string;
    feed: string;
    title: string;
};

app.get('/ingest', async (req, res) => {
    const key = req.body.key;
    if (key != process.env.KEY) {
        res.status(403).send("Wrong key!");
        return;
    }
    const output = await sendIngest();
    res.send(output);
})

/**
 * Route to trigger sync manually. Does not disrupt cronjob.
 */
app.post('/ingest', async (req, res) => {
    try {
        const feedEntry: FeedEntry = req.body;
        let timeForDigest = DateTime.now().setZone("America/Los_Angeles");
        if (timeForDigest.hour > 10) {
            timeForDigest = timeForDigest.plus({days: 1});
        }
        const date = timeForDigest.toFormat("LLL dd, yyyy");
    
        if (!entryStorage[date]) {
            entryStorage[date] = [];
        } 
        entryStorage[date].push(feedEntry);
        Logger.info(`Saved feed entry '${feedEntry.title}' for ${date}!`);
        res.send('Saved feed entry!');
    } catch (e) {
        res.status(400).send(`Cannot parse feed JSON: ${e}`);
    }
});

if (!process.env.DISCORD_WEBHOOK_URL) {
    Logger.error("Cannot run! Need Discord webhook URL!");
}
if (!process.env.KEY) {
    Logger.error("Cannot run! No auth key for manual digest call!");
}
Logger.info('Ready. Listening on port 8099!');
app.listen(8099, 'localhost');