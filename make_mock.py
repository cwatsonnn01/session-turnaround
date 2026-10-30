"""Builds fixtures/mock.json: about two months of made-up sessions for local preview.

The formula columns (Stage, day counts, Flag) are computed here the same way the
sheet's formulas compute them, so the preview behaves like the real thing.
Run: python3 scripts/make_mock.py
"""
import datetime as dt
import json
import random
from pathlib import Path

random.seed(7)
TODAY = dt.date(2026, 10, 30)
PROMISE, RED, AMBER, CLIENT_TARGET = 5, 5, 4, 2

STUDIOS = ["Studio 1", "Studio 3", "Studio 4", "Studio 5", "Studio 7"]
# Made-up home studios and speeds for the preview only.
TEAM = [
    ("Emily Sorlie", "Producer", "Studio 1", 3.0),
    ("Ryan Mohamed", "Producer", "Studio 3", 4.2),
    ("Rachel Colic", "Producer", "Studio 4", 3.4),
    ("Dave Johnson", "Producer", "Studio 5", 5.1),
    ("Folasade Apanisile", "Producer", "Studio 7", 3.8),
    ("Tamika", "CP Trainer", "", 0),
]
CLIENTS = [
    ("Alta Technologies", "Studio 1"), ("OTR Solutions", "Studio 1"), ("PB&J", "Studio 1"), ("Verifast", "Studio 1"),
    ("Prometheus", "Studio 1"), ("Prometheus", "Studio 3"), ("Viadex", "Studio 3"), ("Guesty", "Studio 3"),
    ("Kairos Blueprint", "Studio 3"), ("Jones Law Firm", "Studio 3"), ("Growthbook", "Studio 4"), ("Databook", "Studio 4"),
    ("Elevate Ops", "Studio 4"), ("HelloHire", "Studio 4"), ("Zuar", "Studio 5"), ("MySherpa", "Studio 5"),
    ("Kairos Blueprint", "Studio 5"), ("Signal Advisors", "Studio 5"), ("Recap", "Studio 7"), ("Bluegator", "Studio 7"),
    ("Modern IT", "Studio 7"), ("Cleanlist", "Studio 7"),
]
HEADERS = ["Client", "Studio", "Producer", "Session", "Brainstorm complete", "Recorded", "Sent to client",
           "Client responded", "Client decision", "Rework returned", "Approved", "Scheduled in Planable", "Stage",
           "Internal days (recorded to sent)", "Client wait days", "Rework overdue", "Days recorded to approval",
           "Past 5-day promise (recorded to sent)", "Flag", "Notes", "Nudge requested", "Last updated by"]


def is_bd(d):
    return d.weekday() < 5


def add_bd(d, n):
    while n > 0:
        d += dt.timedelta(days=1)
        if is_bd(d):
            n -= 1
    return d


def networkdays(a, b):
    n, d = 0, a
    while d <= b:
        n += is_bd(d)
        d += dt.timedelta(days=1)
    return n


def fmt(d):
    return f"{d:%a} {d:%b} {d.day}" if d else ""


rows = []
counter = {}
start = TODAY - dt.timedelta(days=62)
for i in range(70):
    client, studio = random.choice(CLIENTS)
    home = [t for t in TEAM if t[2] == studio]
    prod = home[0] if home and random.random() < 0.85 else random.choice(TEAM[:5])
    rec = start + dt.timedelta(days=random.randint(0, 62))
    while not is_bd(rec):
        rec += dt.timedelta(days=1)
    if rec > TODAY:
        continue
    counter[client] = counter.get(client, 0) + 1
    brain = add_bd(rec, 0) - dt.timedelta(days=random.choice([2, 3, 4]))
    speed = max(1, round(random.gauss(prod[3], 1.2)))
    sent = add_bd(rec, speed)
    sent = sent if sent <= TODAY else None
    resp = add_bd(sent, max(0, round(random.gauss(1.8, 1.4)))) if sent else None
    resp = resp if resp and resp <= TODAY else None
    decision = ("Rework" if random.random() < 0.25 else "Approved") if resp else ""
    rework_back = None
    if decision == "Rework":
        rework_back = add_bd(resp, 0 if random.random() < 0.8 else 1)
        rework_back = rework_back if rework_back <= TODAY else None
    approved = None
    if decision == "Approved":
        approved = resp
    elif rework_back:
        approved = add_bd(rework_back, 1)
        approved = approved if approved <= TODAY else None
    sched = add_bd(approved, 1) if approved else None
    sched = sched if sched and sched <= TODAY else None

    N = networkdays(rec, sent or TODAY) - 1
    O = networkdays(sent, resp or TODAY) - 1 if sent else ""
    P = "Yes" if decision == "Rework" and not rework_back and TODAY > resp else "No"
    Q = networkdays(rec, approved or TODAY) - 1
    R = "Yes" if N > PROMISE else "No"
    if sched:
        S, stage = "DONE", "Done"
    elif (not sent and N >= RED) or P == "Yes":
        S = "RED"
    elif not sent and N >= AMBER:
        S = "AMBER"
    elif sent and not resp and O > CLIENT_TARGET:
        S = "CLIENT LATE"
    else:
        S = "GREEN"
    if not sched:
        stage = ("4. Distribution" if approved else "3. Approval / rework" if resp else
                 "3. Awaiting client" if sent else "2. Production")
    rows.append([client, studio, prod[0], f"Session {counter[client]}", fmt(brain), fmt(rec), fmt(sent), fmt(resp),
                 decision, fmt(rework_back), fmt(approved), fmt(sched), stage, str(N), str(O), P, str(Q), R, S, "", "",
                 ""])

# A few open problems so every flag shows up in the preview.
def bd_ago(n):
    d = TODAY
    while n > 0:
        d -= dt.timedelta(days=1)
        n -= is_bd(d)
    return d


for client, studio, prod, rec_ago, sent_ago, resp_ago, decision, flag, note in [
    ("Zuar", "Studio 5", "Dave Johnson", 7, None, None, "", "RED", "Editor out sick"),
    ("Signal Advisors", "Studio 5", "Dave Johnson", 6, None, None, "", "RED", ""),
    ("Viadex", "Studio 3", "Ryan Mohamed", 6, 2, 1, "Rework", "RED", "Client wants new hooks"),
    ("Growthbook", "Studio 4", "Rachel Colic", 6, 4, None, "", "CLIENT LATE", ""),
    ("Kairos Blueprint", "Studio 3", "Ryan Mohamed", 8, 5, None, "", "CLIENT LATE", "Chased by email"),
]:
    counter[client] = counter.get(client, 0) + 1
    rec, sent, resp = bd_ago(rec_ago), sent_ago is not None and bd_ago(sent_ago), resp_ago is not None and bd_ago(resp_ago)
    N = networkdays(rec, sent or TODAY) - 1
    O = networkdays(sent, resp or TODAY) - 1 if sent else ""
    stage = "3. Approval / rework" if resp else "3. Awaiting client" if sent else "2. Production"
    rows.append([client, studio, prod, f"Session {counter[client]}", fmt(rec - dt.timedelta(days=3)), fmt(rec),
                 fmt(sent or None), fmt(resp or None), decision, "", "", "", stage, str(N), str(O),
                 "Yes" if decision == "Rework" else "No", str(networkdays(rec, TODAY) - 1),
                 "Yes" if N > PROMISE else "No", flag, note, "", ""])

# Two sessions not yet recorded.
for client, studio in [("Zuar", "Studio 5"), ("Recap", "Studio 7")]:
    counter[client] = counter.get(client, 0) + 1
    rows.append([client, studio, [t for t in TEAM if t[2] == studio][0][0], f"Session {counter[client]}",
                 fmt(TODAY - dt.timedelta(days=1)), "", "", "", "", "", "", "", "2. Awaiting recording", "", "", "No",
                 "", "", "NOT RECORDED", "", "", ""])

data = {
    "headers": HEADERS,
    "rows": rows,
    "clients": [[c, s, "Sample Contact", "contact@example.com"] for c, s in CLIENTS],
    "settings": [["Promise", str(PROMISE)], ["RED", str(RED)], ["AMBER", str(AMBER)], ["Client target", str(CLIENT_TARGET)], ["Rework", "0"]],
    "studios": [[s] for s in STUDIOS],
    "team": [[n, "", r, s] for n, r, s, _ in TEAM],
    "asOf": "Fri, Oct 30 (sample data)",
}
out = Path(__file__).resolve().parent.parent / "fixtures" / "mock.json"
out.write_text(json.dumps(data, indent=1))
print(f"{len(rows)} sample sessions written to {out}")
