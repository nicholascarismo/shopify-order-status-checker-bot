import 'dotenv/config';
import pkg from '@slack/bolt';
const { App } = pkg;


const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,   // xapp-...
  socketMode: true,
  processBeforeResponse: true
});

/* =========================
   Config
========================= */
const ORDER_REGEX = /\bC#\d{4,5}\b/g;

const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN;           // e.g. carismodesign.myshopify.com
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2025-10';

const LOCK_CHANNEL    = process.env.ORDER_CHANNEL_ID || null;

/* =========================
   Shopify GQL
========================= */
// fulfillments is a simple list (no edges/node)
const ORDER_GQL = `
  query ($q: String!) {
    orders(first: 1, query: $q) {
      edges {
        node {
          id
          name
          createdAt
          displayFulfillmentStatus
          fulfillments { createdAt status }
          customer { displayName }

          # Process-driving metafields
          weeksSinceOrder: metafield(namespace: "custom", key: "weeks_since_order") { value }
          arrangeStatus:   metafield(namespace: "custom", key: "arrange_status") { value }
          arrangedWith:    metafield(namespace: "custom", key: "_nc_arranged_with") { value }
          incoming:        metafield(namespace: "custom", key: "_nc_incoming_") { value }
          reserveIncoming: metafield(namespace: "custom", key: "_nc_reserve_incoming_") { value }
          readyToContact:  metafield(namespace: "custom", key: "ready_to_contact") { value }

          needsFollowUp:   metafield(namespace: "custom", key: "_nc_needs_follow_up_") { value }
          followUpNotes:   metafield(namespace: "custom", key: "follow_up_notes") { value }

          owesReturn:      metafield(namespace: "custom", key: "owes_return_or_exchange_") { value }
          returnNotes:     metafield(namespace: "custom", key: "return_notes") { value }

          invoicedWith:    metafield(namespace: "custom", key: "_back_end_incoming_invoice") { value }
        }
      }
    }
  }
`;

async function getOrderByName(orderName) {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
      'Shopify-API-Version': SHOPIFY_VERSION,
    },
    body: JSON.stringify({
      query: ORDER_GQL,
      variables: { q: `name:'${orderName}' status:any` },
    }),
  });
  if (!resp.ok) throw new Error(`Shopify HTTP ${resp.status}`);
  const data = await resp.json();

  if (data.errors?.length) throw new Error(`Shopify GQL errors: ${JSON.stringify(data.errors)}`);
  if (data.data?.errors?.length) throw new Error(`Shopify data.errors: ${JSON.stringify(data.data.errors)}`);

  return data?.data?.orders?.edges?.[0]?.node ?? null;
}

/* =========================
   Helpers
========================= */
const val = (mf, fallback = '') => {
  const v = mf?.value?.toString().trim();
  return v && v.length ? v : fallback;
};
const isYes = (s, yes = 'INCOMING') => (s || '').toUpperCase() === yes;
const isEq  = (s, target) => (s || '').toUpperCase() === (target || '').toUpperCase();
const isBlankOrNo = (s) => {
  if (!s) return true;
  const t = (s || '').trim().toUpperCase();
  return t === '' || t === 'NO';
};

function weeksSince(dateIso) {
  if (!dateIso) return null;
  const dt = new Date(dateIso);
  const now = new Date();
  const ms = now.getTime() - dt.getTime();
  const weeks = ms / (1000 * 60 * 60 * 24 * 7);
  return Math.round(weeks * 10) / 10; // 1 decimal
}

// plain array of fulfillments
function mostRecentFulfillmentAt(order) {
  const list = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  if (!list.length) return null;
  const dates = list
    .map(f => f?.createdAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a));
  return dates[0] || null;
}

function adminOrderUrlFromGid(gid) {
  const numericId = gid?.split('/').pop();
  return numericId
    ? `https://${SHOPIFY_DOMAIN}/admin/orders/${numericId}`
    : `https://${SHOPIFY_DOMAIN}/admin`;
}

/**
 * Build concise status + relevant details, per your rules.
 * Returns { headerText, blurbLines: string[], details: Array<{label, value}>, footer: string[] }
 */
function analyzeOrder(order) {
  const name = order?.name || '—';
  const customer = order?.customer?.displayName || '—';
  const dispFulfill = order?.displayFulfillmentStatus || '—';

  const mf = {
    weeks:           val(order.weeksSinceOrder),                  // "12.3"
    arrangeStatus:   val(order.arrangeStatus).toUpperCase(),      // NEED TO ARRANGE / ARRANGED / ''
    arrangedWith:    val(order.arrangedWith),
    incoming:        val(order.incoming).toUpperCase(),           // INCOMING / NOT YET / ''
    reserveIncoming: val(order.reserveIncoming).toUpperCase(),    // RESERVED INCOMING INVENTORY / NO / ''
    readyToContact:  val(order.readyToContact).toUpperCase(),     // READY TO CONTACT / CONTACT LATER / ''
    needsFollowUp:   val(order.needsFollowUp).toUpperCase(),      // NEEDS FOLLOW-UP / NO / ''
    followUpNotes:   val(order.followUpNotes),
    owesReturn:      val(order.owesReturn).toUpperCase(),         // OWES RETURN / NO / ''
    returnNotes:     val(order.returnNotes),
    invoice:         val(order.invoicedWith),
  };

  const headerText = `${name} — ${customer}`;

  const blurb = [];
  const details = [];
  const detailsAdded = new Set(); // keys to prevent duplicates

  const addDetail = (key, label, value) => {
    if (!value) return;
    if (detailsAdded.has(key)) return;
    details.push({ label, value });
    detailsAdded.add(key);
  };

  // Fulfilled vs not
  const fulfilledAt = mostRecentFulfillmentAt(order);
  const isFulfilled = (dispFulfill || '').toUpperCase() === 'FULFILLED';
  if (isFulfilled) {
    const w = weeksSince(fulfilledAt);
    blurb.push(`✅ Fulfilled ${typeof w === 'number' ? `${w} weeks ago` : '(date unavailable)'}.`);
    addDetail('invoice', 'Invoiced With', mf.invoice);
  } else {
    blurb.push(`⏳ Not yet fulfilled (${mf.weeks ? `${mf.weeks} weeks open` : 'age unknown'}).`);
  }

  // NEED TO ARRANGE
  if (isEq(mf.arrangeStatus, 'NEED TO ARRANGE')) {
    blurb.push(`🧩 Not yet arranged with supplier — check Follow-Up Notes for the reason.`);
    addDetail('followUpNotes', 'Follow-Up Notes', mf.followUpNotes);
    if (!isFulfilled) addDetail('weeks', 'Weeks Since Order', mf.weeks);
  }

  // ARRANGED (but not yet incoming)
  if (isEq(mf.arrangeStatus, 'ARRANGED') && !isYes(mf.incoming, 'INCOMING')) {
    blurb.push(`🛠️ Arranged with supplier (not yet incoming).`);
    addDetail('arrangedWith', 'Arranged With', mf.arrangedWith);
    if (!isFulfilled) addDetail('weeks', 'Weeks Since Order', mf.weeks);
  }

  // INCOMING
  if (isYes(mf.incoming, 'INCOMING')) {
    const alsoArranged = isEq(mf.arrangeStatus, 'ARRANGED');
    if (alsoArranged) {
      blurb.push(`📦 Partially incoming: some items are on the way; others still arranged/not invoiced.`);
      addDetail('followUpNotes', 'Follow-Up Notes', mf.followUpNotes);
    } else {
      blurb.push(`📦 Incoming from supplier — pending arrival & final QC.`);
    }
    addDetail('invoice', 'Invoiced With', mf.invoice);
    if (!isFulfilled) addDetail('weeks', 'Weeks Since Order', mf.weeks);
  }

  // READY TO CONTACT / CONTACT LATER
  if (isEq(mf.readyToContact, 'READY TO CONTACT')) {
    blurb.push(`📞 Ready to contact customer (team should coordinate next steps).`);
    addDetail('invoice', 'Invoiced With', mf.invoice);
  } else if (isEq(mf.readyToContact, 'CONTACT LATER')) {
    blurb.push(`⏲️ Contact later: items are here & passed QC, but it’s not yet time to contact.`);
    addDetail('weeks', 'Weeks Since Order', mf.weeks);
    addDetail('invoice', 'Invoiced With', mf.invoice);
  }

  // NEEDS FOLLOW-UP
  if (isEq(mf.needsFollowUp, 'NEEDS FOLLOW-UP')) {
    blurb.push(`⚠️ Needs follow-up — see details for context.`);
    addDetail('followUpNotes', 'Follow-Up Notes', mf.followUpNotes);
  }

  // RESERVED INCOMING INVENTORY
  if (isEq(mf.reserveIncoming, 'RESERVED INCOMING INVENTORY')) {
    blurb.push(`🏷️ Reserved incoming inventory earmarked for this order.`);
    addDetail('arrangedWith', 'Arranged/Reserved With', mf.arrangedWith);
  }

  // OWES RETURN
  if (isEq(mf.owesReturn, 'OWES RETURN')) {
    blurb.push(`↩️ Customer owes a return.`);
    addDetail('returnNotes', 'Return Notes', mf.returnNotes);
  }

  if (blurb.length === 0) {
    blurb.push(`ℹ️ No exceptions detected.`);
  }

  const adminUrl = adminOrderUrlFromGid(order.id);
  const footer = [`<${adminUrl}|Open in Shopify Admin>`];

  return { headerText, blurbLines: blurb, details, footer };
}

/* =========================
   Slack events
========================= */
app.event('message', async ({ event, client }) => {
  try {
    if (event.subtype || !event.text || event.bot_id) return;
    if (LOCK_CHANNEL && event.channel !== LOCK_CHANNEL) return;

    const matches = [...event.text.matchAll(ORDER_REGEX)].map(m => m[0]);
    if (!matches.length) return;

    for (const orderName of matches) {
      const order = await getOrderByName(orderName);

      if (!order) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `Couldn’t find an order named *${orderName}*.`
        });
        continue;
      }

      const { headerText, blurbLines, details, footer } = analyzeOrder(order);

      const blocks = [];

      // Big, visible header
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: headerText }
      });

      blocks.push({ type: 'divider' });

      // Blurb
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: blurbLines.join('\n') }
      });

      // Relevant details (deduped)
      if (details.length) {
        blocks.push({ type: 'divider' });

        // chunk fields so we never blow Slack limits
        const fieldChunks = [];
        let current = [];
        for (const d of details) {
          current.push({ type: "mrkdwn", text: `*${d.label}*\n${d.value || '—'}` });
          if (current.length === 10) {
            fieldChunks.push(current);
            current = [];
          }
        }
        if (current.length) fieldChunks.push(current);

        for (const chunk of fieldChunks) {
          blocks.push({ type: 'section', fields: chunk });
        }
      }

      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer.join(' • ') }] });

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `${order.name} — summary`,
        blocks
      });
    }
  } catch (err) {
    console.error(err);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `Sorry, I hit an error looking that up.`
      });
    } catch {}
  }
});

/* =========================
   Start
========================= */
(async () => {
  await app.start(); // Socket Mode: no HTTP port
  console.log('✅ order-status-checker is running (Socket Mode)');
})();