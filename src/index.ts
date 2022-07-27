import { config } from 'dotenv';
import express from 'express';
import { DateTime } from 'luxon';
import { scheduleJob, RecurrenceRule } from 'node-schedule';
import bodyParser from 'body-parser';
import { MessageEmbed, WebhookClient } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import Logger from './utils/Logger';

config();

const prisma = new PrismaClient();

// Parse JSON body.
const app = express();
app.use(bodyParser.json());

// Setup time for sending the ingest.
//
// Ideally, it's 10 PM PST every day.
const timeToSendIngest = new RecurrenceRule();
timeToSendIngest.tz = 'America/Los_Angeles';
timeToSendIngest.dayOfWeek = 0;
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
  Logger.info('Sending feed for the week!');
  // Get the next Sunday 10 AM of the week.
  const timeForDigest = DateTime.now()
    .setZone('America/Los_Angeles')
    .set({
      weekday: 7, hour: 10, second: 0, minute: 0,
    });
  const digest = await prisma.feedEntry.findMany({
    where: {
      date: {
        gte: timeForDigest.minus({ weeks: 1 }).toJSDate(),
        lt: timeForDigest.toJSDate(),
      },
    },
  });
  let embedText = '';
  // It's possible I didn't make any entries or it's empty for the day.
  if (!digest || digest.length === 0) {
    const webhookEmbed = new MessageEmbed()
      .setTitle('Nothing this week! 😅')
      .setColor('RED')
      .setDescription('Just a chill week with no big reads...')
      .setFooter({
        text: "Disclaimer: It's possible I missed all of Matei's messages. Oops.",
      });
    const webhookURLs = process.env.DISCORD_WEBHOOK_URL.split(',');
    await Promise.all(webhookURLs.map(async (url) => {
      const webhook = new WebhookClient({ url });
      await webhook.send({
        embeds: [webhookEmbed],
      });
    }));
  } else {
    // ..otherwise, make the description text.
    digest.forEach((entry, index) => {
      embedText += `**${index + 1}.** [${entry.title}](${entry.link})`;
      embedText += '\n';
      embedText += `_Feed:_ \`${entry.feed}\``;
      embedText += '\n';
    });
    // If too many articles...
    if (digest.length > 10) {
      embedText += '\n';
      embedText += 'Just a few more this time around!';
      embedText += '\n';
    }
    // Either way, send what we got.
    embedText = embedText.substring(0, embedText.length - 1);
    const webhookEmbed = new MessageEmbed()
      .setTitle(`Posts for Week ${timeForDigest.weekNumber}`)
      .setColor('BLUE')
      .setDescription(embedText)
      .setFooter({
        text: 'Disclaimer: This is not sorted in any particular order of interest.',
      });
    const webhookURLs = process.env.DISCORD_WEBHOOK_URL.split(',');
    await Promise.all(webhookURLs.map(async (url) => {
      const webhook = new WebhookClient({ url });
      await webhook.send({
        embeds: [webhookEmbed],
      });
    }));
  }
  Logger.info('Done with sending ingest!');
  return 'Done!';
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
}

/**
 * Middleware function to check for correct key. Should match envvar exactly.
 */
const checkForKey = (req, res, next) => {
  const bearerHeader = req.headers.authorization;
  if (bearerHeader) {
    const bearer = bearerHeader.split(' ');
    const bearerToken = bearer[1];
    if (bearerToken === process.env.KEY) {
      req.token = bearerToken;
      next();
    } else {
      res.status(403).send('Wrong key!');
    }
  } else {
    // No key!
    res.status(403).send('No key!');
  }
};

/**
 * Route to get next ingest queued.
 */
app.get('/ingest', checkForKey, async (req, res) => {
  // Get the next Sunday 10 AM of the week.
  const timeForDigest = DateTime.now()
    .setZone('America/Los_Angeles')
    .set({
      weekday: 7, hour: 10, second: 0, minute: 0,
    });
  const feedEntries = await prisma.feedEntry.findMany({
    where: {
      date: {
        gte: timeForDigest.minus({ weeks: 1 }).toJSDate(),
        lt: timeForDigest.toJSDate(),
      },
    },
  });
  res.json(feedEntries);
});

/**
 * Route to trigger sync manually. Does not disrupt cronjob.
 */
app.post('/ingest', checkForKey, async (req, res) => {
  const output = await sendIngest();
  res.send(output);
});

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
    await prisma.feedEntry.create({
      data: {
        link: feedEntry.link,
        title: feedEntry.title,
        feed: feedEntry.feed,
      },
    });
    Logger.info(`Saved feed entry '${feedEntry.title}' with URL '${feedEntry.link}' from feed '${feedEntry.feed}'!`);
    res.send('Saved feed entry!');
  } catch (e) {
    res.status(400).send(`Cannot parse feed JSON: ${e}`);
  }
});

// Check for envvars and run.
if (!process.env.DISCORD_WEBHOOK_URL) {
  Logger.error('Cannot run! Need Discord webhook URL!');
} else if (!process.env.KEY) {
  Logger.error('Cannot run! No auth key for manual digest call!');
} else {
  Logger.info('Ready. Listening on port 8099!');
  app.listen(8099, 'localhost');
}
