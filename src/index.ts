import { config } from 'dotenv';
import express from 'express';
import Logger from './utils/Logger';
import { DateTime } from 'luxon';
import { scheduleJob, RecurrenceRule } from 'node-schedule';
import bodyParser from 'body-parser';
import { MessageEmbed, WebhookClient } from 'discord.js';

config();

const entryStorage: Record<string, FeedEntry[]> = {};

// Parse JSON body.
const app = express();
app.use(bodyParser.json());

// Setup time for sending the ingest.
//
// Ideally, it's 10 PM PST every day.
const timeToSendIngest = new RecurrenceRule();
timeToSendIngest.tz = "America/Los_Angeles";
timeToSendIngest.minute = 0;
timeToSendIngest.second = 0;
timeToSendIngest.hour = 10;

/**
 * Sends the ingest to Discord.
 * 
 * The function builds a description string out of all queued feed entries
 * for that day and then adds some zingers in case the number isn't 5
 * feed entries specifically.
 * 
 * @returns The message to relay to the web client, if any.
 */
const sendIngest = async () => {
    Logger.info('Sending feed for the day!');
    const webhook = new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL });
    const today = DateTime.now().setZone("America/Los_Angeles");
    const date = today.toFormat("LLL dd, yyyy");
    const digest = entryStorage[date];
    let embedText = "";
    // It's possible I didn't make any entries or it's empty for the day.
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
        // ..otherwise, make the description text.
        digest.forEach((entry, index) => {
            embedText += `**${index + 1}.** _${entry.title}_: ${entry.link}`
            embedText += "\n";
            embedText += `_Feed:_ \`${entry.feed}\``
            embedText += "\n";
        })
        // If too few...
        if (digest.length < 5) {
            embedText += "\n";
            embedText += "Matei was quite lazy today. He didn't send 5 articles! 🙄";
            embedText += "\n";
        // If too many...
        } else if (digest.length > 5) {
            embedText += "\n";
            embedText += "Sorry for the amount! Just a few more!";
            embedText += "\n";
        }
        // Either way, send what we got.
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
 * Cronjob to send the ingest every day at 10 PM PST.
 */
scheduleJob(timeToSendIngest, async () => {
    sendIngest();
});

export interface FeedEntry {
    link: string;
    feed: string;
    title: string;
};

/**
 * Middleware function to check for correct key. Should match envvar exactly.
 */
 const checkForKey = (req, res, next) => {
    const bearerHeader = req.headers['authorization'];
    if (bearerHeader) {
      const bearer = bearerHeader.split(' ');
      const bearerToken = bearer[1];
      if (bearerToken === process.env.KEY) {
        req.token = bearerToken;
        next();
      } else {
        res.status(403).send('Wrong key!');
        return;
      }
    } else {
      // No key!
      res.status(403).send('No key!');
      return;
    }
};

/**
 * Route to get next ingest queued.
 */
app.get('/ingest', checkForKey, async (req, res) => {
    let timeForDigest = DateTime.now().setZone("America/Los_Angeles");
        if (timeForDigest.hour > 10) {
            timeForDigest = timeForDigest.plus({days: 1});
        }
    const date = timeForDigest.toFormat("LLL dd, yyyy");
    if (!entryStorage[date]) {
        entryStorage[date] = [];
        res.status(404).json([]);
        return;
    }
    res.json(entryStorage[date]);
})

/**
 * Route to trigger sync manually. Does not disrupt cronjob.
 */
app.post('/ingest', checkForKey, async (req, res) => {
    const output = await sendIngest();
    res.send(output);
})

/**
 * Route to add feed entry to daily post. Will add to next day's ingest.
 */
app.put('/ingest', checkForKey, async (req, res) => {
    try {
        if (!req.body.link) {
            throw new Error('Missing link field!');
        }
        if (!req.body.title) {
            throw new Error('Missing title field!');
        }
        if (!req.body.feed) {
            throw new Error('Missing feed field!');
        }
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
        Logger.info(`Saved feed entry '${feedEntry.title}' with URL '${feedEntry.link}' from feed '${feedEntry.feed}' for ${date}!`);
        res.send('Saved feed entry!');
    } catch (e) {
        res.status(400).send(`Cannot parse feed JSON: ${e}`);
    }
});

// Check for envvars and run.
if (!process.env.DISCORD_WEBHOOK_URL) {
    Logger.error("Cannot run! Need Discord webhook URL!");
} else if (!process.env.KEY) {
    Logger.error("Cannot run! No auth key for manual digest call!");
} else {
    Logger.info('Ready. Listening on port 8099!');
    app.listen(8099, 'localhost');
}