# ego-browser

Language for the agent-controlled browsing experience and its optional stealth capabilities.

## Language

**Agent browser**:
A browser instance owned by the agent for a task, separate from the user's personal browser.
_Avoid_: user browser, system browser

**Chrome backend**:
The default agent browser, used when live observation and direct human takeover are needed.
_Avoid_: ego engine, main engine

**Camoufox backend**:
An optional Firefox-based agent browser used when fingerprint-sensitive browsing matters more than live-panel integration.
_Avoid_: stealth mode, Chrome replacement

**Stealth kit**:
The shared capabilities for recognising anti-bot defenses, checking identity coherence and reusing an established clearance.
_Avoid_: antidetect engine, bypass kit

**Clearance**:
Evidence that a particular browser identity has already satisfied a site's challenge, reusable only while it remains valid for that identity.
_Avoid_: login, captcha solution
