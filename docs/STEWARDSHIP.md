# 🕊️ Stewardship — a guide for stewards

> 🚧 **Draft.** Stewardship is being built in stages. The **Caseload** (resolving conflicts between
> members) and in-app **mediation channels** are live; the **Watch** (spotting harm patterns
> proactively) is still on the way. Sections marked **🔜 Coming** describe where we're headed — we'll
> fill in the details as we build them. If something here doesn't match what you see in the app yet,
> trust the app; this page is the north star, not the changelog.

---

## 💛 What stewardship is

Most platforms have exactly one tool for interpersonal harm: **moderation** — "is this post
allowed?" → keep it or remove it. That's necessary, but it answers the wrong question for a lot of
what actually hurts in a community. It can't address *"two members are in a dispute"* or *"this person
is being piled on."* Those aren't content problems. They're **relationship and community** problems.

**Stewardship is the other half.** As a steward, you're a trusted community member empowered to help
people through conflict and to protect members who are being targeted — *without* needing to be a
deployment operator with the keys to everything.

You sit in a trust tier **between a regular member and an operator**:

```
member  ──▶  ⭐ steward  ──▶  operator
            (you are here)
```

You can investigate and mediate conflicts and recommend or take protective action. You **don't** get
the operator's god-view over the whole deployment — your tools are scoped to the stewardship work.

> 🧭 **Moderation vs. stewardship, in one line:** moderation decides *whether a post stays*;
> stewardship tends *the people and the relationships*. They connect — a case can end in content
> removal — but they start from different questions.

---

## 🧠 The philosophy (this matters — please read it)

The way you hold conflict shapes whether the community heals or hardens. A few principles guide
everything in this guide. These aren't bureaucracy — they're the whole point.

### 🌱 Repair first, removal last
We lean **restorative / transformative**, not punitive. The goal of a case is usually to *repair* a
harm or *separate* two people who don't need to be friends — not to punish. Removing content and
escalating is a real tool, but it's the **last resort**, not the default. The case outcomes are
deliberately ordered that way.

### ⚖️ Power-aware, not "neutral"
**Not every conflict has two equal sides.** A swarm of accounts piling onto one trans woman's post is
**not** "a disagreement between members" — treating it as symmetric, demanding she defend herself,
re-victimizes the person being targeted. When you see this, you name it (the **Targeting** flag, below)
and you act **protectively**. False balance is a failure mode we design *against*.

### 🤝 Consent-based
Restorative processes work when people *opt in*. You can offer mediation; you can't force a kumbaya.
If someone declines, that's fine — the case routes toward separation or protection instead.

### 🔒 Privacy of the harmed
Gather what you need from the content and the context. **Don't** make the person who was hurt relive
it or re-justify their pain to you. They've been through enough.

### 🧊 Async &amp; cooling-off
A lot of online conflict is just *public + real-time*. Moving a dispute somewhere private and slow is
often 80% of the de-escalation. That's exactly what **mediation channels** (below) are for — a private,
async space, built on the existing chat.

---

## 🧰 Your toolkit

Stewardship has **two faces**. One is live today; one is on the way.

### 1. 📋 Caseload — resolving conflicts *(live ✅)*
The reactive side: a **case** records a conflict between two people and walks it to resolution.

### 2. 📡 Watch — spotting patterns *(🔜 Coming)*
The proactive side: surfacing emerging harm before anyone files a report — pile-ons, dogpiles,
clusters of accounts converging on one target, harassment spikes. *Not built yet; the Steward tab is
designed to grow this second face.*

---

## 📋 Working a case

A **case** is the heart of the Caseload. It records:

- the **two people** — a **complainant** (who was harmed / raised it) and a **respondent**,
- the **content** at issue, if any (a post or comment),
- a **summary** of what's going on,
- a **timeline** of everything that's happened (append-only — nothing is silently changed),
- and where it stands.

### 🚪 How a case starts
- **From a report.** In the **Moderation** tab, while reviewing a report, hit **"Open steward case."**
  It seeds a case from the report — the reporter becomes the complainant, the content author the
  respondent. *(This is the main on-ramp.)*
- **Cold.** In the **Steward** tab, hit **New case** and describe the conflict. Use this when something
  needs stewarding that didn't come through a report.

### 🔄 The lifecycle
A case moves through three states:

| State | Meaning |
|---|---|
| 🟡 **Open** | Just landed. Needs a steward to pick it up. |
| 🤝 **In mediation** | Actively being worked — you're talking to the people, gathering context. |
| ✅ **Closed** | Resolved, with an **outcome** recorded (below). |

You can **assign** a case to yourself so others know it's covered, drop **notes** into the timeline as
you go, and move it between states as it progresses.

### 🎯 The Targeting flag
If a case isn't a symmetric dispute — it's **one person being targeted** (a pile-on, coordinated
harassment, hate directed at someone for who they are) — mark it **Targeting**. This is the
power-aware lever from the philosophy above. It tells everyone (and steers the case) that the job here
is **protection**, not both-sides mediation. Use it without hesitation when it fits. 🛡️

### 🏁 Closing a case — the outcomes
When you close a case, you record *how* it resolved. The outcomes are ordered **repair → protection →
last-resort**, on purpose:

| Outcome | When |
|---|---|
| 💚 **Repaired** | The harm was acknowledged and the relationship mended. The best outcome. |
| ↔️ **Separated** | No repair needed — the parties just disengage (mute/block/part ways). |
| 🛡️ **Protective action** | Action taken to protect a targeted member. |
| 🚫 **Escalated** | Last resort: the content is **removed**. Reached only via the **Escalate** button. |
| 🤍 **Dismissed** | No action warranted (e.g. not actually a conflict). |

### ⛔ Escalation (the serious one)
**Escalate &amp; remove** is the one outcome that takes content down. When you escalate, the post or
comment is removed (recorded as a steward action), the case closes as **Escalated**, and any
originating report is resolved. It's powerful and it's permanent-ish — reach for repair, separation,
and protection first. Escalation is what you do when those aren't enough or aren't appropriate (e.g.
clear, removable abuse).

> 📝 *Escalation removes **posts, comments, and chat messages** — a removed chat message disappears for
> everyone in the conversation (it stays visible to operators for review).*

---

## 💬 Mediation channels *(live)*

The hardest part of a case is usually just *talking to people*. Mediation channels give you a **private,
async space** to do that — built on the same chat the community already uses. The parties see the channel
in their normal inbox; you read and post from the case in the admin.

There are two shapes, and which you get is a **per-deployment setting** an operator chooses in
**Settings → Stewardship → Mediation channels**:

### 🤲 Caucus *(always available)*
A **1:1 private channel between you and one party** — one for the complainant, one for the respondent.
You shuttle between them. This is **caucus mediation**: it fully preserves the privacy-of-the-harmed —
the respondent never sees who raised the case, because they're never in a room with them. For a
**Targeting** case, this is the *only* shape you get (and rightly so).

### 🫂 Joint room *(hybrid mode only)*
A **shared room with you and both parties** — true face-to-face mediation, for when both people *consent*
and the conflict is genuinely symmetric. A joint room is offered **only** when:

- the deployment is in **hybrid** mode (the default), **and**
- the case is **not** flagged **Targeting**, **and**
- both a complainant and a respondent are on the case.

If any of those isn't true, you stick to caucus. (A joint room inevitably reveals the parties to each
other — which is the whole point when it's consensual, and exactly why we never force it.)

### 🙋 Consent
Opening a channel **invites** the party (they get a notification) — it never forces them. They take part
by replying, or step away by leaving. No forced kumbaya: if someone won't engage, the case routes toward
separation or protection instead.

### 🌇 When the case closes
What happens to the channels on close is also an operator setting:

- **Archive read-only** *(default)* — posting locks, the history stays, and a "case resolved" line is
  posted. A gentle wind-down that keeps the record.
- **Lock &amp; remove parties** — posting locks and the parties leave the channel; you keep read access
  for the audit trail.
- **Leave open** — nothing changes; the channel stays a normal chat.

---

## 🪪 Becoming a steward

Stewardship is **granted by a deployment operator** — there's no self-signup. An operator adds you in
the admin (**Steward → Stewards**), and the role takes effect the next time you sign in or your
session refreshes. An operator can revoke it the same way.

Operators are automatically stewards too (their god-view includes everything stewards can do), so
they can pitch in on the caseload.

---

## 🔜 Coming

Things we've designed for but haven't built yet — this section will grow:

- **📡 The Watch** — proactive pile-on / targeting detection over reactions, replies, and the
  automated-moderation signals, so you can catch harm *before* a report. Includes putting a **watch**
  on a member who's been targeted so new hits surface immediately.
- *(more as we go)*

## 🔔 Participant notifications *(live)*

The people in a case are kept informed through their normal in-app notifications — **how much**, and
**who**, is a per-deployment choice an operator sets in **Settings → Stewardship**:

- **Power-aware** *(default)* — the complainant hears at every stage (a steward is reviewing →
  in mediation → resolved); the respondent is told **only** when their content is actually removed (or a
  protective action is taken), and is **never** told who raised the case. Honors privacy of the harmed
  and doesn't tip off / pre-accuse.
- **Symmetric** — both parties are notified at every stage (the respondent still never learns the
  complainant's identity).
- **Resolution-only** — quietest: notify only at close.

A respondent notification **never** carries the complainant's identity, in any mode.

---

## 📖 Quick glossary

- **Steward** — a trusted community member granted the role to resolve conflicts. *(You! 💛)*
- **Operator** — a deployment admin with the project-wide god-view.
- **Case** — a record of a conflict between two members, with a lifecycle and an outcome.
- **Complainant / Respondent** — the two people in a case.
- **Targeting** — the flag marking a case as one-sided harm (a pile-on / harassment), not a symmetric dispute.
- **Escalation** — the last-resort outcome that removes the content.
- **Caseload** — the reactive, case-by-case side of stewardship *(live)*.
- **Mediation channel** — a private, async chat for a case. **Caucus** = steward ↔ one party (always
  available); **joint room** = steward + both parties (hybrid mode, consensual, non-targeting only).
- **Watch** — the proactive, pattern-spotting side *(🔜 coming)*.

---

*Thank you for stewarding. This work — holding people gently through their worst moments and
protecting those who are targeted — is some of the most important work in any community. 🫶*
