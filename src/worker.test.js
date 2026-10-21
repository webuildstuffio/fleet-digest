import { describe, expect, test } from "bun:test";
import worker, { torontoMidnightUtcMs, torontoToday, dayWindow, renderDigest, renderWeekly, weekDays, mergeSections, collect } from "./worker.js";

describe("Toronto day windows", () => {
  test("EDT midnight is 04:00 UTC", () => {
    expect(new Date(torontoMidnightUtcMs("2026-10-20")).toISOString()).toBe("2026-10-20T04:00:00.000Z");
  });
  test("EST midnight is 05:00 UTC", () => {
    expect(new Date(torontoMidnightUtcMs("2026-01-15")).toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });
  test("spring-forward day still starts at EST midnight (05:00 UTC)", () => {
    expect(new Date(torontoMidnightUtcMs("2026-03-08")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });
  test("fall-back day starts at EDT midnight (04:00 UTC) and runs 25 h", () => {
    const w = dayWindow("2026-11-01");
    expect(w.start).toBe("2026-11-01 04:00:00.000");
    expect(w.end).toBe("2026-11-02 05:00:00.000");
  });
  test("torontoToday reads the Toronto calendar date", () => {
    // 2026-10-21 03:30 UTC is still Oct 20 in Toronto (EDT).
    expect(torontoToday(Date.parse("2026-10-21T03:30:00Z"))).toBe("2026-10-20");
    expect(torontoToday(Date.parse("2026-10-21T04:30:00Z"))).toBe("2026-10-21");
  });
});

describe("renderDigest", () => {
  test("counts totals and lists addresses with positions", () => {
    const d = renderDigest("2026-10-20", [
      { site: { name: "playlist.rest" }, confirmed: [{ email: "a@b.com", position: 3 }], pending: 1, cleaned: 2 },
      { site: { name: "anywrapped" }, confirmed: [], pending: 0, cleaned: 0 },
    ]);
    expect(d.total).toBe(1);
    expect(d.subject).toContain("1 new confirmed");
    expect(d.text).toContain("a@b.com (#3)");
    expect(d.html).toContain("2 expired cleaned");
  });
});

describe("collect + /run", () => {
  const d1Fake = (rows) => ({
    prepare: (sql) => ({
      bind: () => ({
        all: async () => ({ results: rows.filter((r) => sql.includes("confirmed_at >=")) }),
      }),
      first: async () => ({ n: 1 }),
      run: async () => ({ meta: { changes: 2 } }),
    }),
  });
  const makeEnv = () => ({
    DIGEST_RUN_TOKEN: "sekrit",
    mails: [],
    EMAIL: { send: async (m) => { throw new Error("set per-test"); } },
    PL_DB: d1Fake([]), PW_DB: d1Fake([]), AG_DB: d1Fake([]),
    AW_KV: { list: async () => ({ keys: [], list_complete: true }), get: async () => null },
  });

  test("collect reads confirmed rows inside the window per D1", async () => {
    const env = makeEnv();
    const w = dayWindow("2026-10-20");
    env.PL_DB = d1Fake([{ email: "in@b.com", position: 5 }]);
    const sections = await collect(env, "2026-10-20");
    expect(sections[0].confirmed).toEqual([{ email: "in@b.com", position: 5 }]);
    expect(sections[0].pending).toBe(1);
    expect(sections[0].cleaned).toBe(2);
    expect(w.start).toBe("2026-10-20 04:00:00.000");
  });

  test("/run rejects a bad token and accepts the right one", async () => {
    const env = makeEnv();
    env.EMAIL = { send: async (m) => { env.mails.push(m); } };
    const bad = await worker.fetch(new Request("https://x/run", { method: "POST" }), env);
    expect(bad.status).toBe(401);
    const ok = await worker.fetch(new Request("https://x/run?day=2026-10-20", {
      method: "POST", headers: { authorization: "Bearer sekrit" },
    }), env);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.day).toBe("2026-10-20");
    expect(body.sent).toBe(true); // manual runs always send (the proof path)
    expect(env.mails[0].to).toBe("support@webuildstuff.io");
    expect(env.mails[0].from.email).toBe("digest@webuildstuff.io");
  });
});

describe("weekly digest", () => {
  const day = (pl, pw, ag, aw) => ([
    { site: { name: "playlist.rest" }, confirmed: pl, pending: 0, cleaned: 0 },
    { site: { name: "powerful.build" }, confirmed: pw, pending: 0, cleaned: 0 },
    { site: { name: "api.gripe" }, confirmed: ag, pending: 0, cleaned: 0 },
    { site: { name: "anywrapped" }, confirmed: aw, pending: 0, cleaned: 0 },
  ]);
  const empty = () => day([], [], [], []);

  test("weekDays returns the 7 days ending on the given day", () => {
    expect(weekDays("2026-10-25")).toEqual([
      "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22",
      "2026-10-23", "2026-10-24", "2026-10-25",
    ]);
    expect(weekDays("2026-11-02")[0]).toBe("2026-10-27"); // month rollover
  });

  test("mergeSections concatenates confirmed, takes latest pending", () => {
    const wk = [empty(), empty(), empty(), empty(), empty(), empty(), empty()];
    wk[1][0].confirmed = [{ email: "a@b.com", position: 3 }];
    wk[5][0].confirmed = [{ email: "c@d.com", position: 4 }];
    wk[6][0].pending = 2;
    wk[6][0].cleaned = 1;
    const merged = mergeSections(wk);
    expect(merged[0].confirmed.map((c) => c.email)).toEqual(["a@b.com", "c@d.com"]);
    expect(merged[0].pending).toBe(2);
    expect(merged[0].cleaned).toBe(1);
    expect(merged[1].confirmed).toEqual([]);
  });

  test("renderWeekly totals the week and names the range", () => {
    const sections = mergeSections([empty(), empty(), empty(), empty(), empty(), empty(),
      day([{ email: "x@y.com", position: 1 }], [], [], [])]);
    sections[0].pending = 1;
    const w = renderWeekly("2026-10-19", "2026-10-25", sections);
    expect(w.total).toBe(1);
    expect(w.subject).toContain("week of 2026-10-19");
    expect(w.text).toContain("x@y.com (#1)");
    expect(w.text).toContain("Weekly rollup");
  });

  test("/run?mode=weekly reports the week ending on the given day", async () => {
    const mails = [];
    const d1Fake = (rows) => ({
      prepare: (sql) => ({
        bind: () => ({ all: async () => ({ results: rows.filter(() => sql.includes("confirmed_at >=")) }) }),
        first: async () => ({ n: 0 }),
        run: async () => ({ meta: { changes: 0 } }),
      }),
    });
    const env = {
      DIGEST_RUN_TOKEN: "sekrit",
      EMAIL: { send: async (m) => { mails.push(m); } },
      PL_DB: d1Fake([]), PW_DB: d1Fake([]), AG_DB: d1Fake([]),
      AW_KV: { list: async () => ({ keys: [], list_complete: true }), get: async () => null },
    };
    const res = await worker.fetch(new Request("https://x/run?mode=weekly&day=2026-10-25", {
      method: "POST", headers: { authorization: "Bearer sekrit" },
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("weekly");
    expect(body.week).toBe("2026-10-19..2026-10-25");
    expect(body.sent).toBe(true); // manual runs always send (proof path)
    expect(mails[0].subject).toContain("week of 2026-10-19");
  });
});
