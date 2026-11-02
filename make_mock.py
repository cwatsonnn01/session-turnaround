"""Builds mock.json: about a year of made-up sessions for local preview.

Formula columns (Stage, day counts, Flag, Stuck) are computed the same way the
sheet's formulas compute them, so the preview behaves like the real thing.
Run: python3 make_mock.py
"""
import datetime as dt
import json
import random
from pathlib import Path

random.seed(11)
TODAY = dt.date(2026, 11, 2)
PROMISE, RED, AMBER, CLIENT_TARGET, STUCK = 5, 5, 4, 2, 3
HOLIDAYS = {dt.date(2026, 1, 1), dt.date(2026, 2, 16), dt.date(2026, 4, 3), dt.date(2026, 5, 18), dt.date(2026, 7, 1),
            dt.date(2026, 8, 3), dt.date(2026, 9, 7), dt.date(2026, 10, 12), dt.date(2025, 12, 25), dt.date(2025, 12, 26)}

STUDIOS = [f"Studio {i}" for i in range(1, 8)]
# Made-up speeds per CP for the preview only (mean business days to content ready).
TEAM = [("Emily Sorlie", "emily@demandii.com", "Producer", 3.2), ("Ryan Mohamed", "ryanmohamed@demandii.com", "Producer", 4.1),
        ("Rachel Colic", "rachel@demandii.com", "Producer", 3.6), ("Dave Johnson", "dave@demandii.com", "Producer", 5.0),
        ("Folasade Apanisile", "folasade@demandii.com", "Producer", 3.9), ("Tamika", "tamika@demandii.com", "CP Trainer", 0),
        ("Tina Moffatt", "christina@demandii.com", "Ops", 0)]
CLIENTS = [("Alta Technologies", "Studio 1"), ("OTR Solutions", "Studio 1"), ("PB&J", "Studio 1"), ("Verifast", "Studio 1"),
           ("Prometheus", "Studio 1"), ("Prometheus", "Studio 3"), ("Viadex", "Studio 3"), ("Guesty", "Studio 3"),
           ("Kairos Blueprint", "Studio 3"), ("Jones Law Firm", "Studio 3"), ("Growthbook", "Studio 4"), ("Databook", "Studio 4"),
           ("Elevate Ops", "Studio 4"), ("HelloHire", "Studio 4"), ("Zuar", "Studio 5"), ("MySherpa", "Studio 5"),
           ("Kairos Blueprint", "Studio 5"), ("Signal Advisors", "Studio 5"), ("Recap", "Studio 7"), ("Bluegator", "Studio 7"),
           ("Modern IT", "Studio 7"), ("Cleanlist", "Studio 7")]
CP_FOR_STUDIO = {"Studio 1": "Emily Sorlie", "Studio 3": "Ryan Mohamed", "Studio 4": "Rachel Colic", "Studio 5": "Dave Johnson",
                 "Studio 7": "Folasade Apanisile"}
HEADERS = ["Client", "Studio", "Producer", "Session", "Brainstorm complete", "Recorded", "Sent to client", "Client responded",
           "Client decision", "Rework returned", "Approved", "Scheduled in Planable", "Stage", "Internal days (recorded to sent)",
           "Client wait days", "Rework overdue", "Days recorded to approval", "Past 5-day promise (recorded to sent)", "Flag", "Notes",
           "Nudge requested", "Last updated by", "Chaser ID", "Chaser status", "Status updated", "Changes requested (latest)",
           "Rework rounds", "Business days since update", "Stuck", "Alerts sent"]


def workday(d):
    return d.weekday() < 5 and d not in HOLIDAYS


def add_bd(d, n):
    while n > 0:
        d += dt.timedelta(days=1)
        n -= workday(d)
    return d


def nwd(a, b):  # NETWORKDAYS(a, b) - 1
    n, d = 0, a
    while d <= b:
        n += workday(d)
        d += dt.timedelta(days=1)
    return n - 1


def fmt(d):
    return f"{d:%a} {d:%b} {d.day}, {d.year}" if d else ""


def cap(d):
    return d if d and d <= TODAY else None


rows, counter = [], {}


def add_row(client, studio, cp, rec, sent, resp, decision, changes, returned, approved, sched, rounds, status_day, status):
    counter[client] = counter.get(client, 0) + 1
    N = nwd(rec, sent or TODAY)
    O = nwd(sent, resp or TODAY) if sent else ""
    rework_open = decision == "Rework" and not returned
    P = "Yes" if rework_open and TODAY > add_bd(changes, 0) else "No"
    R = "Yes" if N > PROMISE else "No"
    if sched:
        S, stage = "DONE", "Done"
    else:
        stage = ("4. Distribution" if approved else "3. Approval / rework" if resp else "3. Awaiting client" if sent else "2. Production")
        if (not sent and N >= RED) or P == "Yes":
            S = "RED"
        elif not sent and N >= AMBER:
            S = "AMBER"
        elif sent and not resp and O > CLIENT_TARGET:
            S = "CLIENT LATE"
        else:
            S = "GREEN"
    since = "" if S == "DONE" else nwd(status_day, TODAY)
    waiting = (sent and not resp) or (returned and not approved)
    stuck = "" if since == "" else ("Yes" if since >= STUCK and not waiting else "No")
    rows.append([client, studio, cp, f"Session {counter[client]}", "", fmt(rec), fmt(sent), fmt(resp), decision, fmt(returned),
                 fmt(approved), fmt(sched), stage, str(N), str(O), P, str(nwd(rec, approved or TODAY)), R, S, "", "",
                 f"Chaser ({cp}), {status_day.isoformat()}", f"CH-{len(rows) + 1000}", status, fmt(status_day), fmt(changes),
                 str(rounds) if rounds else "", str(since), stuck, ""])


speed = {t[0]: t[3] for t in TEAM}
start = TODAY - dt.timedelta(days=330)
for _ in range(240):
    client, studio = random.choice(CLIENTS)
    cp = CP_FOR_STUDIO[studio] if random.random() < 0.85 else random.choice(list(CP_FOR_STUDIO.values()))
    rec = start + dt.timedelta(days=random.randint(0, 330))
    while not workday(rec):
        rec += dt.timedelta(days=1)
    if rec > TODAY:
        continue
    # Everyone gets a little faster over the year, so the trend has something to show.
    drift = 0.9 * (1 - (rec - start).days / 330)
    sent = cap(add_bd(rec, max(1, round(random.gauss(speed[cp] + drift, 1.1)))))
    resp = cap(add_bd(sent, max(0, round(random.gauss(1.7, 1.3))))) if sent else None
    decision = ("Rework" if random.random() < 0.27 else "Approved") if resp else ""
    rounds, changes, returned = 0, None, None
    if decision == "Rework":
        rounds = 2 if random.random() < 0.2 else 1
        changes = resp if rounds == 1 else cap(add_bd(resp, 2))
        returned = cap(add_bd(changes, 0 if random.random() < 0.8 else 1)) if changes else None
        if changes is None:
            rounds, changes, returned = 1, resp, cap(add_bd(resp, 0))
    approved = resp if decision == "Approved" else (cap(add_bd(returned, 1)) if returned else None)
    sched = cap(add_bd(approved, random.choice([0, 1, 1, 2, 3]))) if approved else None
    status_day, status = rec, "Session wrapped"
    for d, s in [(sent, "Content ready"), (changes, "requested changes"), (returned, "changes sent back"), (approved, "client approved"), (sched, "scheduled")]:
        if d:
            status_day, status = d, s
    add_row(client, studio, cp, rec, sent, resp, decision, changes, returned, approved, sched, rounds, status_day, status)


def bd_ago(n):
    d = TODAY
    while n > 0:
        d -= dt.timedelta(days=1)
        n -= workday(d)
    return d


# Open problems so every state shows in the preview.
add_row("Zuar", "Studio 5", "Dave Johnson", bd_ago(6), None, None, "", None, None, None, None, 0, bd_ago(6), "Session wrapped")
add_row("Signal Advisors", "Studio 5", "Dave Johnson", bd_ago(4), None, None, "", None, None, None, None, 0, bd_ago(4), "Session wrapped")
add_row("Viadex", "Studio 3", "Ryan Mohamed", bd_ago(7), bd_ago(3), bd_ago(1), "Rework", bd_ago(1), None, None, None, 2, bd_ago(1), "requested changes")
add_row("Growthbook", "Studio 4", "Rachel Colic", bd_ago(7), bd_ago(4), None, "", None, None, None, None, 0, bd_ago(4), "Content ready")
add_row("Bluegator", "Studio 7", "Folasade Apanisile", bd_ago(9), bd_ago(6), bd_ago(5), "Approved", None, None, bd_ago(5), None, 0, bd_ago(5), "client approved")
add_row("Alta Technologies", "Studio 1", "Emily Sorlie", bd_ago(1), None, None, "", None, None, None, None, 0, bd_ago(1), "Session wrapped")
add_row("Recap", "Studio 7", "Folasade Apanisile", bd_ago(2), bd_ago(0), None, "", None, None, None, None, 0, bd_ago(0), "Content ready")

data = {
    "headers": HEADERS,
    "rows": rows,
    "clients": [[c, s, "Sample Contact", "contact@example.com"] for c, s in CLIENTS],
    "settings": [["Promise", str(PROMISE)], ["RED", str(RED)], ["AMBER", str(AMBER)], ["Client target", str(CLIENT_TARGET)],
                 ["Rework", "0"], ["Stuck", str(STUCK)], ["Summary hour", "9"], ["Alerts", "No"], ["Nudge", "No"]],
    "studios": [[s] for s in STUDIOS],
    "team": [[n, e, r] for n, e, r, _ in TEAM],
    "holidays": [fmt(h) for h in sorted(HOLIDAYS)],
    "asOf": "Mon, Nov 2 (sample data)",
}
out = Path(__file__).resolve().parent / "mock.json"
out.write_text(json.dumps(data, indent=1))
print(f"{len(rows)} sample sessions written to {out}")
