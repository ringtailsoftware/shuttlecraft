import fs, {
  existsSync
} from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

import {
  ActivityPub
} from './ActivityPub.js';
import {
  fetchUser
} from './users.js';
import {
  INDEX,
  readJSONDictionary,
  writeJSONDictionary,
  followersFile,
  followingFile,
  blocksFile,
  notificationsFile,
  likesFile,
  accountFile,
  createFileName,
  getFileName,
  boostsFile,
  pathToDMs,
  writeMediaFile,
  readMediaFile
} from './storage.js';
import {
  getActivity,
  createActivity,
  deleteActivity,
  getHashtagsFromNote
} from './notes.js';
import {
    UserEvent
} from '../lib/UserEvent.js';

import debug from 'debug';
import MarkdownIt from 'markdown-it';
import { table } from 'console';
const logger = debug('ono:account');
const md = new MarkdownIt({
  html: true,
  linkify: false,
});

const {
  USERNAME,
  DOMAIN
} = process.env;

console.log('DOMAIN IN ACCOUNT.JS', DOMAIN);

export const getInboxIndex = () => {
  const inboxIndexPath = path.resolve(pathToDMs, `inboxes.json`);
  const inboxIndex = readJSONDictionary(inboxIndexPath, {});
  return inboxIndex;
}

export const writeInboxIndex = (data) => {
  const inboxIndexPath = path.resolve(pathToDMs, `inboxes.json`);
  writeJSONDictionary(inboxIndexPath, data);
}

export const getInbox = (actorId) => {
  const username = ActivityPub.getUsername(actorId);

  const inboxPath = path.resolve(pathToDMs, `${username}.json`);

  const inbox = readJSONDictionary(inboxPath, []);
  return inbox;
}

/**
 * given an activity, return true if the only addressee is this server's owner
 * @param {*} activity 
 * @returns 
 */
export const addressedOnlyToMe = (activity) => {
  // load my info
  const actor = ActivityPub.actor;

  // get all addresses
  let addresses = activity.to;
  addresses = addresses.concat(activity.cc);

  // if there is only 1 addressee, and that addressee is me, return true
  if (addresses.length === 1 && addresses[0] === actor.id) {
    return true;
  }

  return false;
}

export const deleteObject = async (actor, incomingRequest) => {
    if (typeof incomingRequest.object !== 'object') {
        return false;
    }
    if (incomingRequest.object.type !== 'Tombstone') {
        return false;
    }
    const note = await getNote(incomingRequest.object.id);
    if (note.attributedTo != actor.id) { // only allow actor to delete their own Notes
        return false;
    }

    deleteActivity(incomingRequest.object.id);
    return true;
}

export const acceptDM = (dm, inboxUser) => {

  const inboxIndex = getInboxIndex();
  const inbox = getInbox(inboxUser);
  const username = ActivityPub.getUsername(inboxUser);

  inbox.push(dm);

  const inboxPath = path.resolve(pathToDMs, `${username}.json`);
  writeJSONDictionary(inboxPath, inbox);
  if (!inboxIndex[inboxUser]) {
    inboxIndex[inboxUser] = {
      lastRead: null,
    }
  }

  const timestamp = new Date(dm.published).getTime();
  inboxIndex[inboxUser].latest = timestamp;

  // if this is me sending an outbound DM, mark last read also
  if (dm.attributedTo === ActivityPub.actor.id) {
    inboxIndex[inboxUser].lastRead = timestamp;
  }

  writeInboxIndex(inboxIndex);

  if (dm.attributedTo !== ActivityPub.actor.id) {
    UserEvent.sendEvent('dm');
  }
}

export const writeMedia = (attachment) => {
  logger('write media', attachment.hash, attachment.type);
  writeMediaFile(attachment.hash, attachment); // store the JSON, so we have the type and data in a single file
}

export const readMedia = (filename) => {
  logger('read media', filename);
  return readMediaFile(filename);
}

export const isMyPost = (activity) => {
  return (activity.id.startsWith(`https://${DOMAIN}/m/`));
}

export const isFollowing = (actorId) => {
  const following = getFollowing();
  return following.some((f) => f.actorId === actorId)
}

export const isMention = (activity) => {
  return activity.tag?.some((tag) => {
    return tag.type === 'Mention' && tag.href === ActivityPub.actor.id;
  });
}

export const isReplyToMyPost = (activity) => {
  // has inReplyTo AND it matches the pattern of our posts.
  // TODO: Do we need to ACTUALLY validate that this post exists?
  return (activity.inReplyTo && activity.inReplyTo.startsWith(`https://${DOMAIN}/m/`));
}

export const isReplyToFollowing = async (activity) => {
  // fetch the parent, check ITs owner to see if we follow them.
  try {
    const parentPost = await getActivity(activity.inReplyTo);
    if (isFollowing(parentPost.attributedTo)) {
      return true;
    }
  } catch (err) {
    console.error('Could not parent post', activity.id, err);
  }
  return false;
}

function createActor(name, domain, pubkey) {
  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1'
    ],
    'id': `https://${domain}/u/${name}`,
    'url': `https://${domain}/`,
    'type': 'Person',
    'name': `${name}`,
    'preferredUsername': `${name}`,
    'inbox': `https://${domain}/api/inbox`,
    'outbox': `https://${domain}/api/outbox`,
    'followers': `https://${domain}/u/${name}/followers`,
    "icon": {
      "type": "Image",
      "mediaType": "image/png",
      "url": `https://${domain}/images/avatar.png`
    },
    "image": {
      "type": "Image",
      "mediaType": "image/png",
      "url": `https://${domain}/images/header.png`
    },
    'publicKey': {
      'id': `https://${domain}/u/${name}#main-key`,
      'owner': `https://${domain}/u/${name}`,
      'publicKeyPem': pubkey
    }
  };
}

function createWebfinger(name, domain) {
  return {
    'subject': `acct:${name}@${domain}`,

    'links': [{
      'rel': 'self',
      'type': 'application/activity+json',
      'href': `https://${domain}/u/${name}`
    }]
  };
}

export const getOutboxPosts = async (offset) => {

  // sort all known posts by date quickly
  const sortedSlice = INDEX.filter((p) => p.type === 'note').sort((a, b) => {
    if (a.published > b.published) {
      return -1;
    } else if (a.published < b.published) {
      return 1;
    } else {
      return 0;
    }
  });

  const total = sortedSlice.length;

  const posts = await Promise.all(sortedSlice.slice(offset, offset + 10).map(async (p) => {
    return await getNote(p.id);
  }));

  return {
    total,
    posts
  };
}

export const addNotification = (notification) => {
  const notifications = getNotifications();
  notifications.push({
    time: new Date().getTime(),
    notification: notification,
  });
  writeNotifications(notifications);
  UserEvent.sendEvent('notification');
}

const writeNotifications = (notifications) => {
  return writeJSONDictionary(notificationsFile, notifications);
}

export const getNotifications = () => {
  return readJSONDictionary(notificationsFile);
}


const writeBlocks = (data) => {
  return writeJSONDictionary(blocksFile, data);
}

export const isBlocked = (actor) => {
  const blocks = getBlocks();
  return blocks.some((banned) => {
    if (banned === actor) {
      console.log('BLOCKED: banned user');
      return true;
    } else if (actor.startsWith(banned)) {
      console.log('BLOCKED: banned domain');
      return true;
    }
    return false;
  });
}

export const getBlocks = () => {
  return readJSONDictionary(blocksFile, []);
}

const writeFollowers = (followers) => {
  return writeJSONDictionary(followersFile, followers);
}

export const getFollowers = () => {
  return readJSONDictionary(followersFile);
}

export const writeFollowing = (followers) => {
  return writeJSONDictionary(followingFile, followers);
}

export const getFollowing = () => {
  return readJSONDictionary(followingFile).map((f) => {
    if (typeof f === 'string') {
      // map old format to new format just in case
      // TODO: remove this before release
      return {
        id: f,
        actorId: f,
      }
    } else {
      return f;
    }
  })
}

export const writeBoosts = (data) => {
  return writeJSONDictionary(boostsFile, data);
}

export const getBoosts = () => {
  return readJSONDictionary(boostsFile, []);
}


export const writeLikes = (likes) => {
  return writeJSONDictionary(likesFile, likes);
}

export const getLikes = () => {
  return readJSONDictionary(likesFile);
}

export const recordVote = async(id, name, actor) => {
    const noteFile = getFileName(id);
    let note = await getNote(id);
    note.votersCount++;
    // TODO: record who voted for what and discount multiple votes
    // TODO: prevent multiple votes from single actor to oneOf
    if (note.anyOf) {
        note.anyOf.forEach((ao) => {
            if (ao.name === name) {
                ao.replies.totalItems++;
            }
        });
    }
    if (note.oneOf) {
        note.oneOf.forEach((ao) => {
            if (ao.name === name) {
                ao.replies.totalItems++;
            }
        });
    }
    writeJSONDictionary(noteFile, note);
}

export const getNote = async (id) => {
  // const postFile = path.resolve('./', pathToPosts, guid + '.json');
  const noteFile = getFileName(id);

  if (fs.existsSync(noteFile)) {
    try {
      return readJSONDictionary(noteFile, {});
    } catch (err) {
      console.error(err);
      return undefined;
    }
  }
  return undefined;
}

export const sendCreateToFollowers = async (object) => {
  const followers = await getFollowers();
  followers.forEach(async (follower) => {
    const account = await fetchUser(follower);
    try {
      ActivityPub.sendCreate(account.actor, object);
    } catch(err) {
      // TODO: should retry
      console.error('Failed to deliver outbound post', err);
    }
  });
}
export const sendUpdateToFollowers = async (object) => {
  const followers = await getFollowers();
  followers.forEach(async (follower) => {
    const account = await fetchUser(follower);
    try {
      ActivityPub.sendUpdate(account.actor, object);
    } catch(err) {
      // TODO: should retry
      console.error('Failed to deliver outbound post', err);
    }
  });
}


export const createNote = async (body, cw, inReplyTo, name, toUser, polldata, attachmentInfo, editOf) => {
  const publicAddress = "https://www.w3.org/ns/activitystreams#Public";

  let d = new Date();
  let guid;
  if (editOf) {
    // use same guid as post we're updating
    guid = editOf.replace(`https://${ DOMAIN }/m/`, '');
  } else {
    // generate new guid
    guid = crypto.randomBytes(16).toString('hex');
  }
  let directMessage;

  // default to public
  let to = [publicAddress];

  // default recipient is my followers  
  let cc = [
    ActivityPub.actor.followers
  ];

  let attachment;
  if (attachmentInfo) {
    attachment = [
        {
            type: 'Document',
            mediaType: attachmentInfo.type.split('/')[0],
            url: `https://${ DOMAIN }/media/${attachmentInfo.hash}.${attachmentInfo.type.split('/')[1]}`,
            name: attachmentInfo.description,
            focalPoint: attachmentInfo.focalPoint,
            blurhash: attachmentInfo.blurhash,
            width: attachmentInfo.width,
            height: attachmentInfo.height
        }
    ];
    if (attachmentInfo.width) {
        attachment.width = attachmentInfo.width;
    }
    if (attachmentInfo.height) {
        attachment.height = attachmentInfo.height;
    }
  }

  // Contains mentions
  const tags = [];  

  if (inReplyTo || toUser) {
    if (toUser) {

      // TODO: validate the to field is a legit account
      to = [toUser];
      cc = [];
      directMessage = true;

    } else {
      // get parent post
      // so we can get the author and add to TO list
      const parent = await getActivity(inReplyTo);
      if (addressedOnlyToMe(parent)) {
        // this is a reply to a DM
        // set the TO to be ONLY to them (override public)
        to = [parent.attributedTo];
        // clear the CC list
        cc = [];
        directMessage = true;

      } else {
        cc.push(parent.attributedTo);
      }
    }
  }

  // Process content in various ways...
  let processedContent = body;

  // cribbed directly from mastodon
  // https://github.com/mastodon/mastodon/blob/main/app/models/account.rb
  const MENTION_RE    = /(?<=^|[^\/\w])@(([a-z0-9_]+([a-z0-9_\.-]+[a-z0-9_]+)?)(?:@[\w\.\-]+[\w]+)?)/ig;

  const mentions = body.match(MENTION_RE);
  if (mentions && mentions.length) {

    const uniqueMentions = [... new Set(mentions)];
    for (var m = 0; m < uniqueMentions.length; m++) {
      let mention = uniqueMentions[m].trim();
      const uname = ActivityPub.getUsername(mention);
      // construct a mastodon-style link
      // <span class=\"h-card\"><a href=\"https://benbrown.ngrok.io/u/benbrown\" class=\"u-url mention\">@<span>benbrown@benbrown.ngrok.io</span></a></span>
      const account = await fetchUser(uname);

      const link = `<span class="h-card"><a href="${account.actor.url}" class=\"u-url mention\">@<span>${uname}</span></a></span>`;
      processedContent = processedContent.replaceAll(mention, link);

      tags.push({
          "type": "Mention",
          "href": account.actor.url,
          "name": `@${ uname }`
      });

      // if this is not a direct message to a single person,
      // add the mentioned person to the CC list
      if (!directMessage) {
        cc.push(account.actor.id);
      }
    }
  }

  // if this is a DM, require a mention of the recipient
  if (directMessage) {
    const account = await fetchUser(to[0]);
    const uname = ActivityPub.getUsername(to[0]);

    if (!tags.some((t) => t.href === account.actor.url)) {
      const link = `<span class="h-card"><a href="${account.actor.url}" class=\"u-url mention\">@<span>${uname}</span></a></span>`;
      processedContent = link + ' ' + processedContent;

      tags.push({
          "type": "Mention",
          "href": account.actor.url,
          "name": `@${ uname }`
      });
    }
  }

  // if it contains hashtags, add them
  let hashtags = body.match(/#[a-z]+/gi)
  if (hashtags) {
    hashtags.forEach((tag) => {
      tags.push({
        "type": "Hashtag",
        "href": `https://${ DOMAIN }/tags/${tag}`,
        "name": tag
      });
    });
  }

  const mdContent = md.render(processedContent);

  // rewrite links to tags in content
  let content = mdContent.replace(/#([a-z]+)/gi, '<a href="https://' + DOMAIN + '/tags/$1" class="mention hashtag" rel="tag">#<span>$1</span></a>');

  content = '<span class="h-card">' + content + '</span>';

  const activityId = `https://${ DOMAIN }/m/${guid}`;
  const url = `https://${ DOMAIN }/notes/${guid}`;
  const object = {
    "@context": [
        "https://www.w3.org/ns/activitystreams", {
            "ostatus": "http://ostatus.org#",
            "atomUri": "ostatus:atomUri",
            "inReplyToAtomUri": "ostatus:inReplyToAtomUri",
            "conversation": "ostatus:conversation",
            "sensitive": "as:sensitive",
            "toot": "http://joinmastodon.org/ns#",
            "votersCount": "toot:votersCount"
        }
    ],
    "id": activityId,
    "type": polldata ? "Question" : "Note",
    "summary": cw || null,
    "inReplyTo": inReplyTo,
    'published': d.toISOString(),
    'attributedTo': ActivityPub.actor.id,
    'content': content,
    "url": url,
    "to": to,
    "cc": cc,
    directMessage,
    "sensitive": cw ? true : false,
    "atomUri": activityId,
    "inReplyToAtomUri": null,
    "content": content,
    "attachment": attachment || [],
    "tag": tags,
    "replies": {
      "id": `${activityId}/replies`,
      "type": "Collection",
      "first": {
        "type": "CollectionPage",
        "next": `${activityId}/replies?only_other_accounts=true&page=true`,
        "partOf": `${activityId}/replies`,
        "items": []
      }
    }
  };

  // construct anyOf/oneOf block in Question
  if (polldata) { // posting a poll
    object.endTime = new Date(new Date().getTime() + 1000 * polldata.time).toISOString();
    object.votersCount = 0;
    object[polldata.type] = [];
    polldata.choices.forEach((ch) => {
      object[polldata.type].push({
        type: 'Note',
        name: ch,
        replies: {
          type: 'Collection',
          totalItems: 0
        }
      });
    });
  }

  if (name) {   // voting on a poll
    object.name = name;
  }
  if (editOf) { // editing a post
    object.updated = d.toISOString();
  }

  if (directMessage) {
    acceptDM(object, to[0]);
  } else {
    const noteFile = createFileName(object);
    writeJSONDictionary(noteFile, object);
    INDEX.push({
      type: 'note', // someone else
      id: object.id,
      actor: object.attributedTo,
      published: new Date(object.published).getTime(),
      inReplyTo: object.inReplyTo,
      hashtags: getHashtagsFromNote(object),
    });
  }

  // process recipients
  to.concat(cc).forEach(async (recipient) => {
    // if the recipient is "my followers", send it to them

    if (recipient === publicAddress) {
      // do nothing
    } else if (recipient === ActivityPub.actor.followers) {
      if (editOf) {
        sendUpdateToFollowers(object);
      } else {
        sendCreateToFollowers(object);
      }
    } else {
      // otherwise, send it directly to the person
      const account = await fetchUser(recipient);
      if (editOf) {
        ActivityPub.sendUpdate(account.actor, object);
      } else {
        ActivityPub.sendCreate(account.actor, object);
      }
    }
  })

  return object;

}

export const follow = async (request) => {
  logger('following someone');
  const {
    actor
  } = await fetchUser(request.object.object);
  if (actor) {
    if (!isFollowing(actor.id)) {
      const following = getFollowing();
      following.push({
        id: request.object.id, // record the id of the original follow that was just approved
        actorId: actor.id,
      });
      writeFollowing(following);
    }

    // fetch the user's outbox if it exists...
    if (actor.outbox) {
      logger('downloading outbox...');
      ActivityPub.fetchOutbox(actor).then((outbox) => {
        logger('outbox downloaded', outbox.items.length);
        outbox.items.forEach((activity) => {
          if (activity.type === 'Create') {
            // log the post to our activity feed
            createActivity(activity.object);
          } else if (activity.type === 'Announce') {
            // TODO: fetch boosted posts, etc.
          }
        })
      });
    }

  } else {
    logger('Failed to fetch user');
  }
}

export const addFollower = async (request) => {

  logger('Adding follower...');
  const {
    actor
  } = await fetchUser(request.actor);
  if (actor) {
    const followers = getFollowers();
    if (followers.indexOf(actor.id) < 0) {
      followers.push(actor.id);
      writeFollowers(followers);
      addNotification(request);
    }
  } else {
    logger('Failed to fetch user');
  }

}

export const removeFollower = async (follower) => {

  logger('Removing follower...');
  const {
    actor
  } = await fetchUser(follower);
  if (actor) {
    const followers = getFollowers();
    writeFollowers(followers.filter(f => f !== follower));
  } else {
    logger('Failed to fetch user');
  }

}

export const ensureAccount = async (name, domain) => {
  return new Promise((resolve, reject) => {
    if (existsSync(accountFile)) {
      resolve(getAccount());
    } else {
      // generate a crypto key
      crypto.generateKeyPair('rsa', {
        modulusLength: 4096,
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem'
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem'
        }
      }, (err, publicKey, privateKey) => {
        const actorRecord = createActor(name, domain, publicKey);
        const webfingerRecord = createWebfinger(name, domain);
        const apikey = crypto.randomBytes(16).toString('hex');

        const account = {
          actor: actorRecord,
          webfinger: webfingerRecord,
          apikey: apikey,
          publicKey: publicKey,
          privateKey: privateKey,
        }

        console.log('Account created! Wrote webfinger and actor record to', accountFile);
        writeJSONDictionary(accountFile, account);
        resolve(account);
      });
    }
  });
}

export const getAccount = () => {
  return readJSONDictionary(accountFile, {});
}

export const updateAccountActor = (data) => {
  let account = readJSONDictionary(accountFile, {});
  Object.keys(data).forEach((k) => {
    account.actor[k] = data[k];
  });
  writeJSONDictionary(accountFile, account);
}

