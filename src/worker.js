// fleet-digest — one nightly email with the day's confirmed waitlist
// signups across the fleet's coming-soon sites.
//
// Why this exists: the landing Workers used to mail the owner on
// every signup. Owner order 2026-10-21 replaced the per-signup
// alerts with double opt-in (subscribers get the mail, instantly)
// plus ONE end-of-day digest — this Worker. It reads the three
// landing D1s + the anywrapped KV, reports the most recently
// completed America/Toronto day, and cleans up expired D1 pendings
// on the way (KV pendings expire by TTL on their own).
//
// Bindings (wrangler.toml): PL_DB, PW_DB, AG_DB (D1, read-mostly —
// the only write is the expired-pending cleanup), AW_KV (KV, read),
// EMAIL (send-email), DIGEST_RUN_TOKEN (secret, gates /run).

const SITES = [
  { key: "playlist", name: "playlist.rest", domain: "playlist.rest", db: "PL_DB" },
  { key: "powerful", name: "powerful.build", domain: "powerful.build", db: "PW_DB" },
  { key: "api.gripe", name: "api.gripe", domain: "api.gripe", db: "AG_DB" },
  { key: "anywrapped", name: "anywrapped", domain: "anywrapped.com", kv: true },
];

// ── Toronto day windows ────────────────────────────────────────────
// D1 timestamps are UTC strings ('YYYY-MM-DD HH:MM:SS.SSS'); the
// digest day is an America/Toronto calendar day, so the window is
// [Toronto midnight, next Toronto midnight) converted to UTC.
export function torontoMidnightUtcMs(dayStr) {
  const [y, m, d] = dayStr.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = target + 5 * 3600000; // EST offset; refined below
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  for (let i = 0; i < 3; i++) {
    const parts = {};
    for (const p of fmt.formatToParts(new Date(guess))) parts[p.type] = p.value;
    const localMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    const diff = target - localMs;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function addDays(dayStr, n) {
  const [y, m, d] = dayStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function torontoToday(nowMs = Date.now()) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
  });
  for (const p of fmt.formatToParts(new Date(nowMs))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function d1Str(ms) {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

export function dayWindow(dayStr) {
  const startMs = torontoMidnightUtcMs(dayStr);
  const endMs = torontoMidnightUtcMs(addDays(dayStr, 1));
  return { startMs, endMs, start: d1Str(startMs), end: d1Str(endMs) };
}

// ── Collection ─────────────────────────────────────────────────────
async function collectD1(env, site, win) {
  const db = env[site.db];
  const confirmed = await db.prepare(
    "SELECT email, position FROM waitlist WHERE status = 'confirmed' AND confirmed_at >= ? AND confirmed_at < ? ORDER BY confirmed_at",
  ).bind(win.start, win.end).all();
  const pendingRow = await db.prepare(
    "SELECT COUNT(*) AS n FROM waitlist WHERE status = 'pending' AND token_expires_at > datetime('now')",
  ).first();
  const cleaned = await db.prepare(
    "DELETE FROM waitlist WHERE status = 'pending' AND token_expires_at <= datetime('now')",
  ).run();
  return {
    site,
    confirmed: (confirmed.results || []).map((r) => ({ email: r.email, position: r.position })),
    pending: pendingRow ? pendingRow.n : 0,
    cleaned: cleaned.meta ? cleaned.meta.changes : 0,
  };
}

async function collectKV(env, win) {
  const confirmed = [];
  let pending = 0;
  let cursor;
  do {
    const page = await env.AW_KV.list({ prefix: "wl:", cursor });
    for (const k of page.keys) {
      if (k.name === "wl:count" || k.name.startsWith("wl:seq:")) continue;
      // Parse defensively: pre-v2 records may hold a plain string.
      let rec = null;
      try { rec = JSON.parse((await env.AW_KV.get(k.name)) || "null"); } catch { rec = null; }
      if (rec && rec.ts >= win.startMs && rec.ts < win.endMs) {
        confirmed.push({ email: rec.email, position: rec.pos });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  let pcursor;
  do {
    const page = await env.AW_KV.list({ prefix: "pend:", cursor: pcursor });
    // One pend:<token> key per pending signup (pend:mail: mirrors it,
    // pend:done: tombstones don't match the 64-hex shape).
    pending += page.keys.filter((k) => /^pend:[0-9a-f]{64}$/.test(k.name)).length;
    pcursor = page.list_complete ? undefined : page.cursor;
  } while (pcursor);
  confirmed.sort((a, b) => (a.position || 0) - (b.position || 0));
  return { site: SITES[3], confirmed, pending, cleaned: 0 };
}

export async function collect(env, dayStr) {
  const win = dayWindow(dayStr);
  const out = [];
  for (const site of SITES) {
    out.push(site.kv ? await collectKV(env, win) : await collectD1(env, site, win));
  }
  return out;
}

// ── Rendering ──────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function renderDigest(dayStr, sections) {
  const total = sections.reduce((n, s) => n + s.confirmed.length, 0);
  const totalPending = sections.reduce((n, s) => n + s.pending, 0);
  const pretty = new Date(`${dayStr}T12:00:00Z`).toLocaleDateString("en-CA", {
    timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const subject = `Fleet signups — ${dayStr}: ${total} new confirmed`;
  const textParts = [`Fleet waitlist digest — ${pretty}`, ""];
  const htmlParts = [
    `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;color:#111">`,
    `<h1 style="font-size:20px">Fleet waitlist digest</h1>`,
    `<p style="color:#555">${pretty} (America/Toronto) — <strong>${total} new confirmed</strong> across ${sections.length} sites, ${totalPending} still pending confirmation.</p>`,
  ];
  for (const s of sections) {
    textParts.push(`${s.site.name} — ${s.confirmed.length} new, ${s.pending} pending${s.cleaned ? `, ${s.cleaned} expired cleaned` : ""}`);
    htmlParts.push(`<h2 style="font-size:16px;margin-top:24px">${esc(s.site.name)} — ${s.confirmed.length} new · ${s.pending} pending${s.cleaned ? ` · ${s.cleaned} expired cleaned` : ""}</h2>`);
    if (s.confirmed.length) {
      textParts.push(...s.confirmed.map((c) => `  ${c.email}${c.position ? ` (#${c.position})` : ""}`));
      htmlParts.push(`<ul>${s.confirmed.map((c) => `<li>${esc(c.email)}${c.position ? ` — #${c.position}` : ""}</li>`).join("")}</ul>`);
    } else {
      textParts.push("  (none)");
      htmlParts.push(`<p style="color:#777">No new confirmed signups.</p>`);
    }
    textParts.push("");
  }
  textParts.push("Pending signups expire 72 h after the confirm email if never clicked.");
  htmlParts.push(`<p style="color:#777;font-size:13px;margin-top:24px">Pending signups expire 72 h after the confirm email if never clicked. Sent by the fleet-digest Worker.</p></div>`);
  return { subject, text: textParts.join("\n"), html: htmlParts.join("\n"), total };
}

// ── Weeks ──────────────────────────────────────────────────────────
// A digest week is the 7 Toronto days ending on a given day (the
// Monday cron reports the week that ended Sunday).
export function weekDays(endDayStr) {
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(addDays(endDayStr, -i));
  return days;
}

// Merge 7 daily section-lists into one week view: confirmed lists
// concatenate in day order; pending is the latest day's snapshot;
// cleaned sums (each day's own cleanup, reported once).
export function mergeSections(perDaySections) {
  return SITES.map((site, i) => {
    const days = perDaySections.map((sections) => sections[i]);
    return {
      site,
      confirmed: days.flatMap((d) => d.confirmed),
      pending: days.length ? days[days.length - 1].pending : 0,
      cleaned: days.reduce((n, d) => n + (d.cleaned || 0), 0),
    };
  });
}

export function renderWeekly(startDay, endDay, sections) {
  const total = sections.reduce((n, s) => n + s.confirmed.length, 0);
  const totalPending = sections.reduce((n, s) => n + s.pending, 0);
  const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", {
    timeZone: "America/Toronto", month: "long", day: "numeric", year: "numeric",
  });
  const range = `${fmtDay(startDay)} – ${fmtDay(endDay)}`;
  const subject = `Fleet signups — week of ${startDay}: ${total} new confirmed`;
  const textParts = [`Fleet waitlist weekly summary — ${range} (America/Toronto)`, ""];
  const htmlParts = [
    `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;color:#111">`,
    `<h1 style="font-size:20px">Fleet waitlist weekly summary</h1>`,
    `<p style="color:#555">${range} (America/Toronto) — <strong>${total} new confirmed</strong> across ${sections.length} sites, ${totalPending} currently pending confirmation.</p>`,
  ];
  for (const s of sections) {
    textParts.push(`${s.site.name} — ${s.confirmed.length} new this week, ${s.pending} pending`);
    htmlParts.push(`<h2 style="font-size:16px;margin-top:24px">${esc(s.site.name)} — ${s.confirmed.length} new · ${s.pending} pending</h2>`);
    if (s.confirmed.length) {
      textParts.push(...s.confirmed.map((c) => `  ${c.email}${c.position ? ` (#${c.position})` : ""}`));
      htmlParts.push(`<ul>${s.confirmed.map((c) => `<li>${esc(c.email)}${c.position ? ` — #${c.position}` : ""}</li>`).join("")}</ul>`);
    } else {
      textParts.push("  (none)");
      htmlParts.push(`<p style="color:#777">No new confirmed signups this week.</p>`);
    }
    textParts.push("");
  }
  textParts.push("Weekly rollup of the daily fleet digests; a week with no new confirmed signups sends nothing.");
  htmlParts.push(`<p style="color:#777;font-size:13px;margin-top:24px">Weekly rollup of the daily fleet digests; a week with no new confirmed signups sends nothing. Sent by the fleet-digest Worker.</p></div>`);
  return { subject, text: textParts.join("\n"), html: htmlParts.join("\n"), total };
}

async function runWeekly(env, endDayStr, { alwaysSend = false } = {}) {
  const days = weekDays(endDayStr);
  const perDay = [];
  for (const d of days) perDay.push(await collect(env, d));
  const sections = mergeSections(perDay);
  const digest = renderWeekly(days[0], endDayStr, sections);
  let sent = false;
  if ((digest.total > 0 || alwaysSend) && env.EMAIL) {
    await env.EMAIL.send({
      from: { email: "digest@webuildstuff.io", name: "Fleet Digest" },
      to: "support@webuildstuff.io",
      subject: digest.subject,
      html: digest.html,
      text: digest.text,
    });
    sent = true;
  }
  return {
    mode: "weekly",
    week: `${days[0]}..${endDayStr}`,
    total: digest.total,
    sent,
    sites: sections.map((s) => ({ site: s.site.name, confirmed: s.confirmed.length, pending: s.pending })),
  };
}

// ── Runs ───────────────────────────────────────────────────────────
async function runDigest(env, dayStr, { alwaysSend = false } = {}) {
  const sections = await collect(env, dayStr);
  const digest = renderDigest(dayStr, sections);
  let sent = false;
  if ((digest.total > 0 || alwaysSend) && env.EMAIL) {
    await env.EMAIL.send({
      from: { email: "digest@webuildstuff.io", name: "Fleet Digest" },
      to: "support@webuildstuff.io",
      subject: digest.subject,
      html: digest.html,
      text: digest.text,
    });
    sent = true;
  }
  return {
    day: dayStr,
    total: digest.total,
    sent,
    sites: sections.map((s) => ({
      site: s.site.name, confirmed: s.confirmed.length, pending: s.pending, cleaned: s.cleaned,
    })),
  };
}

export default {
  // Cron 15 5 * * * UTC — just after Toronto midnight year-round,
  // reporting the Toronto day that just completed.
  async scheduled(event, env, ctx) {
    const yesterday = addDays(torontoToday(Date.parse(event.scheduledTime)), -1);
    // The Monday cron additionally reports the completed Toronto
    // week (Mon–Sun) as a rollup — only when the week had signups.
    const job = event.cron === "15 5 * * 1"
      ? runWeekly(env, yesterday)
      : runDigest(env, yesterday);
    ctx.waitUntil(job.then(
      (r) => console.log("fleet-digest", JSON.stringify(r)),
      (err) => console.error("fleet-digest failed", err && err.message),
    ));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("fleet-digest: nightly waitlist digest worker. POST /run (token-gated) triggers a manual run.\n", { status: 200 });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      if (!env.DIGEST_RUN_TOKEN || auth !== `Bearer ${env.DIGEST_RUN_TOKEN}`) {
        return new Response("unauthorized\n", { status: 401 });
      }
      const dayParam = url.searchParams.get("day");
      const day = dayParam === "today" || !dayParam
        ? torontoToday()
        : /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : null;
      if (!day) return new Response("bad day\n", { status: 400 });
      if (url.searchParams.get("mode") === "weekly") {
        const endDay = dayParam ? day : addDays(torontoToday(), -1);
        return Response.json(await runWeekly(env, endDay, { alwaysSend: true }));
      }
      const result = await runDigest(env, day, { alwaysSend: true });
      return Response.json(result);
    }
    return new Response("not found\n", { status: 404 });
  },
};
