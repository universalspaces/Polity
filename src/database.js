/**
 * database.js — Single source of truth for all SQLite access.
 *
 * Design decisions:
 *  - All prepared statements are compiled once at module load and cached.
 *  - WAL mode + NORMAL synchronous gives a 5-10× write speedup over the
 *    default journal mode while still being crash-safe.
 *  - Migrations are tracked in a `schema_version` table; each version runs
 *    exactly once, in order, inside a transaction.
 *  - Nothing outside this file calls db.prepare() at runtime — callers
 *    import and call the exported service functions instead.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir   = path.resolve(__dirname, '../data');
mkdirSync(dataDir, { recursive: true });

// ── Open DB ──────────────────────────────────────────────────────────────────

const db = new Database(path.join(dataDir, 'governance.db'));

db.pragma('journal_mode    = WAL');
db.pragma('foreign_keys    = ON');
db.pragma('synchronous     = NORMAL');
db.pragma('cache_size      = -32000'); // 32 MB
db.pragma('temp_store      = MEMORY');
db.pragma('wal_autocheckpoint = 1000');

// ── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    version   INTEGER PRIMARY KEY,
    applied_at INTEGER DEFAULT (unixepoch())
  );

  -- Core configuration
  CREATE TABLE IF NOT EXISTS server_config (
    guild_id                    TEXT    PRIMARY KEY,
    government_name             TEXT    DEFAULT 'The Republic',
    election_channel            TEXT,
    announcement_channel        TEXT,
    court_channel               TEXT,
    legislature_channel         TEXT,
    election_duration_hours     INTEGER DEFAULT 48,
    default_initiative_sigs     INTEGER DEFAULT 10,
    parliament_role             TEXT,
    citizenship_oath            TEXT,
    require_citizenship         INTEGER DEFAULT 0,
    created_at                  INTEGER DEFAULT (unixepoch())
  );

  -- Parties
  CREATE TABLE IF NOT EXISTS parties (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    abbreviation TEXT   NOT NULL,
    description TEXT,
    ideology    TEXT,
    color       TEXT    DEFAULT '#5865F2',
    emoji       TEXT    DEFAULT '🏛️',
    leader_id   TEXT,
    role_id     TEXT,
    founded_at  INTEGER DEFAULT (unixepoch()),
    is_active   INTEGER DEFAULT 1,
    UNIQUE(guild_id, name)
  );

  CREATE TABLE IF NOT EXISTS party_members (
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    party_id   INTEGER NOT NULL REFERENCES parties(id),
    role       TEXT    DEFAULT 'member',
    joined_at  INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, user_id)
  );

  -- Elections
  CREATE TABLE IF NOT EXISTS elections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    office      TEXT    NOT NULL,
    description TEXT,
    status      TEXT    DEFAULT 'registration',
    voting_type TEXT    DEFAULT 'fptp',
    starts_at   INTEGER,
    ends_at     INTEGER,
    created_by  TEXT    NOT NULL,
    created_at  INTEGER DEFAULT (unixepoch()),
    message_id  TEXT,
    winner_id   TEXT
  );

  CREATE TABLE IF NOT EXISTS candidates (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id  INTEGER NOT NULL REFERENCES elections(id),
    user_id      TEXT    NOT NULL,
    party_id     INTEGER REFERENCES parties(id),
    platform     TEXT,
    votes        INTEGER DEFAULT 0,
    registered_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(election_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id  INTEGER NOT NULL REFERENCES elections(id),
    voter_id     TEXT    NOT NULL,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    voted_at     INTEGER DEFAULT (unixepoch()),
    UNIQUE(election_id, voter_id)
  );

  CREATE TABLE IF NOT EXISTS rcv_votes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id INTEGER NOT NULL REFERENCES elections(id),
    voter_id    TEXT    NOT NULL,
    preferences TEXT    NOT NULL,
    voted_at    INTEGER DEFAULT (unixepoch()),
    UNIQUE(election_id, voter_id)
  );

  -- Offices
  CREATE TABLE IF NOT EXISTS offices (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id         TEXT    NOT NULL,
    name             TEXT    NOT NULL,
    description      TEXT,
    role_id          TEXT,
    holder_id        TEXT,
    term_length_days INTEGER DEFAULT 30,
    is_elected       INTEGER DEFAULT 1,
    is_permanent     INTEGER DEFAULT 0,
    assumed_at       INTEGER,
    UNIQUE(guild_id, name)
  );

  CREATE TABLE IF NOT EXISTS office_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    office_name TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    assumed_at  INTEGER NOT NULL,
    vacated_at  INTEGER,
    reason      TEXT    DEFAULT 'term_ended'
  );

  CREATE TABLE IF NOT EXISTS term_limits (
    guild_id    TEXT    NOT NULL,
    office_name TEXT    NOT NULL,
    max_terms   INTEGER NOT NULL DEFAULT 2,
    PRIMARY KEY (guild_id, office_name)
  );

  -- Legislation
  CREATE TABLE IF NOT EXISTS bills (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    content       TEXT    NOT NULL,
    sponsor_id    TEXT    NOT NULL,
    status        TEXT    DEFAULT 'proposed',
    votes_yes     INTEGER DEFAULT 0,
    votes_no      INTEGER DEFAULT 0,
    votes_abstain INTEGER DEFAULT 0,
    quorum        INTEGER,
    voting_deadline INTEGER,
    proposed_at   INTEGER DEFAULT (unixepoch()),
    voted_at      INTEGER,
    message_id    TEXT
  );

  CREATE TABLE IF NOT EXISTS bill_votes (
    bill_id   INTEGER NOT NULL REFERENCES bills(id),
    voter_id  TEXT    NOT NULL,
    vote      TEXT    NOT NULL,
    voted_at  INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (bill_id, voter_id)
  );

  CREATE TABLE IF NOT EXISTS bill_cosponsors (
    bill_id    INTEGER NOT NULL REFERENCES bills(id),
    user_id    TEXT    NOT NULL,
    cosigned_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (bill_id, user_id)
  );

  -- Laws
  CREATE TABLE IF NOT EXISTS laws (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT    NOT NULL,
    title      TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    bill_id    INTEGER REFERENCES bills(id),
    enacted_by TEXT,
    enacted_at INTEGER DEFAULT (unixepoch()),
    is_active  INTEGER DEFAULT 1
  );

  -- Referendums
  CREATE TABLE IF NOT EXISTS referendums (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    description   TEXT    NOT NULL,
    created_by    TEXT    NOT NULL,
    status        TEXT    DEFAULT 'active',
    votes_yes     INTEGER DEFAULT 0,
    votes_no      INTEGER DEFAULT 0,
    votes_abstain INTEGER DEFAULT 0,
    created_at    INTEGER DEFAULT (unixepoch()),
    ends_at       INTEGER,
    result        TEXT
  );

  CREATE TABLE IF NOT EXISTS referendum_votes (
    referendum_id INTEGER NOT NULL REFERENCES referendums(id),
    voter_id      TEXT    NOT NULL,
    vote          TEXT    NOT NULL,
    voted_at      INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (referendum_id, voter_id)
  );

  -- Initiatives
  CREATE TABLE IF NOT EXISTS initiatives (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id            TEXT    NOT NULL,
    title               TEXT    NOT NULL,
    description         TEXT    NOT NULL,
    proposed_action     TEXT    NOT NULL,
    type                TEXT    DEFAULT 'bill',
    creator_id          TEXT    NOT NULL,
    status              TEXT    DEFAULT 'collecting',
    signatures_required INTEGER DEFAULT 10,
    created_at          INTEGER DEFAULT (unixepoch()),
    expires_at          INTEGER,
    fulfilled_at        INTEGER
  );

  CREATE TABLE IF NOT EXISTS initiative_signatures (
    initiative_id INTEGER NOT NULL REFERENCES initiatives(id),
    signer_id     TEXT    NOT NULL,
    signed_at     INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (initiative_id, signer_id)
  );

  -- Impeachments
  CREATE TABLE IF NOT EXISTS impeachments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id       TEXT    NOT NULL,
    target_id      TEXT    NOT NULL,
    office         TEXT    NOT NULL,
    charges        TEXT    NOT NULL,
    brought_by     TEXT    NOT NULL,
    status         TEXT    DEFAULT 'trial',
    votes_convict  INTEGER DEFAULT 0,
    votes_acquit   INTEGER DEFAULT 0,
    votes_abstain  INTEGER DEFAULT 0,
    filed_at       INTEGER DEFAULT (unixepoch()),
    concluded_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS impeachment_votes (
    impeachment_id INTEGER NOT NULL REFERENCES impeachments(id),
    voter_id       TEXT    NOT NULL,
    vote           TEXT    NOT NULL,
    voted_at       INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (impeachment_id, voter_id)
  );

  -- Court
  CREATE TABLE IF NOT EXISTS cases (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    description  TEXT    NOT NULL,
    plaintiff_id TEXT    NOT NULL,
    defendant_id TEXT,
    judge_id     TEXT,
    status       TEXT    DEFAULT 'filed',
    verdict      TEXT,
    ruling       TEXT,
    filed_at     INTEGER DEFAULT (unixepoch()),
    ruled_at     INTEGER,
    message_id   TEXT
  );

  CREATE TABLE IF NOT EXISTS case_appeals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id         TEXT    NOT NULL,
    original_case_id INTEGER NOT NULL REFERENCES cases(id),
    title            TEXT    NOT NULL,
    grounds          TEXT    NOT NULL,
    appellant_id     TEXT    NOT NULL,
    judge_id         TEXT,
    status           TEXT    DEFAULT 'filed',
    verdict          TEXT,
    ruling           TEXT,
    filed_at         INTEGER DEFAULT (unixepoch()),
    ruled_at         INTEGER
  );

  CREATE TABLE IF NOT EXISTS judges (
    guild_id      TEXT    NOT NULL,
    user_id       TEXT    NOT NULL,
    appointed_by  TEXT    NOT NULL,
    appointed_at  INTEGER DEFAULT (unixepoch()),
    is_active     INTEGER DEFAULT 1,
    PRIMARY KEY (guild_id, user_id)
  );

  -- Citizens
  CREATE TABLE IF NOT EXISTS citizens (
    guild_id        TEXT    NOT NULL,
    user_id         TEXT    NOT NULL,
    citizen_number  INTEGER,
    registered_at   INTEGER DEFAULT (unixepoch()),
    reputation      INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  -- Treasury
  CREATE TABLE IF NOT EXISTS treasury (
    guild_id        TEXT    PRIMARY KEY,
    balance         INTEGER DEFAULT 10000,
    currency_name   TEXT    DEFAULT 'Credits',
    currency_symbol TEXT    DEFAULT '₡',
    last_updated    INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS treasury_transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT    NOT NULL,
    type         TEXT    NOT NULL,
    amount       INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    description  TEXT    NOT NULL,
    authorized_by TEXT   NOT NULL,
    recipient_id TEXT,
    created_at   INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS citizen_wallets (
    guild_id TEXT    NOT NULL,
    user_id  TEXT    NOT NULL,
    balance  INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  -- Constitution
  CREATE TABLE IF NOT EXISTS constitution (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id       TEXT    NOT NULL,
    article_number INTEGER NOT NULL,
    title          TEXT    NOT NULL,
    content        TEXT    NOT NULL,
    ratified_at    INTEGER DEFAULT (unixepoch()),
    ratified_by    TEXT,
    is_active      INTEGER DEFAULT 1
  );

  -- Polls
  CREATE TABLE IF NOT EXISTS polls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    description TEXT,
    created_by  TEXT    NOT NULL,
    status      TEXT    DEFAULT 'active',
    options     TEXT    NOT NULL,
    ends_at     INTEGER,
    created_at  INTEGER DEFAULT (unixepoch()),
    message_id  TEXT,
    channel_id  TEXT,
    anonymous   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id      INTEGER NOT NULL REFERENCES polls(id),
    voter_id     TEXT    NOT NULL,
    option_index INTEGER NOT NULL,
    voted_at     INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (poll_id, voter_id)
  );

  -- Recalls
  CREATE TABLE IF NOT EXISTS recalls (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id            TEXT    NOT NULL,
    target_id           TEXT    NOT NULL,
    office              TEXT    NOT NULL,
    reason              TEXT    NOT NULL,
    creator_id          TEXT    NOT NULL,
    status              TEXT    DEFAULT 'collecting',
    signatures_required INTEGER NOT NULL,
    created_at          INTEGER DEFAULT (unixepoch()),
    expires_at          INTEGER,
    election_id         INTEGER REFERENCES elections(id)
  );

  CREATE TABLE IF NOT EXISTS recall_signatures (
    recall_id INTEGER NOT NULL REFERENCES recalls(id),
    signer_id TEXT    NOT NULL,
    signed_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (recall_id, signer_id)
  );

  -- Election reminders
  CREATE TABLE IF NOT EXISTS election_reminders (
    guild_id    TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    election_id INTEGER NOT NULL,
    remind_at   INTEGER NOT NULL,
    sent        INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, election_id)
  );

  -- Audit logs
  CREATE TABLE IF NOT EXISTS activity_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id  TEXT    NOT NULL,
    action    TEXT    NOT NULL,
    actor_id  TEXT,
    target    TEXT,
    details   TEXT,
    logged_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS admin_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT    NOT NULL,
    admin_id   TEXT    NOT NULL,
    action     TEXT    NOT NULL,
    target     TEXT,
    reason     TEXT,
    details    TEXT,
    logged_at  INTEGER DEFAULT (unixepoch())
  );

  -- ── Indexes ────────────────────────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_elections_guild_status   ON elections(guild_id, status);
  CREATE INDEX IF NOT EXISTS idx_candidates_election      ON candidates(election_id);
  CREATE INDEX IF NOT EXISTS idx_votes_election_voter     ON votes(election_id, voter_id);
  CREATE INDEX IF NOT EXISTS idx_rcv_votes_election       ON rcv_votes(election_id, voter_id);
  CREATE INDEX IF NOT EXISTS idx_bills_guild_status       ON bills(guild_id, status);
  CREATE INDEX IF NOT EXISTS idx_bill_votes_bill          ON bill_votes(bill_id, voter_id);
  CREATE INDEX IF NOT EXISTS idx_bill_cosponsors_bill     ON bill_cosponsors(bill_id);
  CREATE INDEX IF NOT EXISTS idx_cases_guild_status       ON cases(guild_id, status);
  CREATE INDEX IF NOT EXISTS idx_citizens_guild           ON citizens(guild_id);
  CREATE INDEX IF NOT EXISTS idx_parties_guild_active     ON parties(guild_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_party_members_party      ON party_members(party_id);
  CREATE INDEX IF NOT EXISTS idx_party_members_user       ON party_members(guild_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_offices_guild            ON offices(guild_id);
  CREATE INDEX IF NOT EXISTS idx_office_history_guild     ON office_history(guild_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_referendums_guild_status ON referendums(guild_id, status);
  CREATE INDEX IF NOT EXISTS idx_referendum_votes         ON referendum_votes(referendum_id, voter_id);
  CREATE INDEX IF NOT EXISTS idx_initiatives_guild_status ON initiatives(guild_id, status);
  CREATE INDEX IF NOT EXISTS idx_initiative_sigs          ON initiative_signatures(initiative_id);
  CREATE INDEX IF NOT EXISTS idx_impeachments_guild       ON impeachments(guild_id, status);
  CREATE INDEX IF NOT EXISTS idx_impeachment_votes        ON impeachment_votes(impeachment_id, voter_id);
  CREATE INDEX IF NOT EXISTS idx_activity_log_guild       ON activity_log(guild_id, logged_at);
  CREATE INDEX IF NOT EXISTS idx_admin_log_guild          ON admin_log(guild_id, logged_at);
  CREATE INDEX IF NOT EXISTS idx_treasury_tx_guild        ON treasury_transactions(guild_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_wallets_guild            ON citizen_wallets(guild_id);
  CREATE INDEX IF NOT EXISTS idx_polls_guild_status       ON polls(guild_id, status);
  CREATE INDEX IF NOT EXISTS idx_poll_votes               ON poll_votes(poll_id, voter_id);
  CREATE INDEX IF NOT EXISTS idx_recalls_guild_status     ON recalls(guild_id, status);
  CREATE INDEX IF NOT EXISTS idx_recall_sigs              ON recall_signatures(recall_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_unsent         ON election_reminders(sent, remind_at);
  CREATE INDEX IF NOT EXISTS idx_laws_guild_active        ON laws(guild_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_activity_log_time        ON activity_log(logged_at);
  CREATE INDEX IF NOT EXISTS idx_admin_log_time           ON admin_log(logged_at);
  CREATE INDEX IF NOT EXISTS idx_treasury_tx_time         ON treasury_transactions(created_at);
`);

// ── Versioned migrations ─────────────────────────────────────────────────────
// Add new migrations to the end of this array. Each runs exactly once.
function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function addColumnIfMissing(table, column, definition) {
  if (tableExists(table) && !columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Keep upgraded installs compatible with the current schema. CREATE TABLE IF NOT
// EXISTS does not add new columns to already-existing tables, so explicitly add
// columns introduced after earlier releases before running data migrations.
addColumnIfMissing('elections', 'voting_type', "TEXT DEFAULT 'fptp'");
addColumnIfMissing('bills', 'quorum', 'INTEGER');
addColumnIfMissing('bills', 'voting_deadline', 'INTEGER');
addColumnIfMissing('polls', 'channel_id', 'TEXT');
addColumnIfMissing('polls', 'anonymous', 'INTEGER DEFAULT 0');
addColumnIfMissing('recalls', 'election_id', 'INTEGER REFERENCES elections(id)');

const MIGRATIONS = [
  {
    name: 'Migrate old elections.office pipe-encoded type to dedicated column',
    run() {
      db.exec(`UPDATE elections
        SET voting_type = CASE
          WHEN office LIKE '%|type:rcv%' THEN 'rcv'
          ELSE 'fptp'
        END,
        office = REPLACE(REPLACE(office, '|type:rcv', ''), '|type:fptp', '')
        WHERE office LIKE '%|type:%';`);
    },
  },
  {
    name: 'Flatten bill_voting_config into bills',
    run() {
      if (!tableExists('bill_voting_config')) return;
      db.exec(`UPDATE bills SET
        quorum           = (SELECT quorum           FROM bill_voting_config WHERE bill_id = bills.id),
        voting_deadline  = (SELECT voting_deadline  FROM bill_voting_config WHERE bill_id = bills.id)
        WHERE EXISTS (SELECT 1 FROM bill_voting_config WHERE bill_id = bills.id);`);
    },
  },
];

const currentVersion = (db.prepare('SELECT MAX(version) as v FROM schema_version').get()?.v) ?? -1;

for (let i = currentVersion + 1; i < MIGRATIONS.length; i++) {
  db.transaction(() => {
    try {
      MIGRATIONS[i].run();
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i);
    } catch (err) {
      console.error(`[DB MIGRATION ${i}] ${MIGRATIONS[i].name} failed:`, err);
      throw err;
    }
  })();
}

// ── Prepared statement cache ─────────────────────────────────────────────────
// Organised by domain. All hot-path queries live here; one-off admin queries
// may still call db.prepare() locally.

export const q = {
  // Config
  getConfig:         db.prepare('SELECT * FROM server_config WHERE guild_id = ?'),
  upsertConfig:      db.prepare(`INSERT OR IGNORE INTO server_config (guild_id) VALUES (?)`),
  upsertTreasury:    db.prepare(`INSERT OR IGNORE INTO treasury (guild_id) VALUES (?)`),

  // Citizens
  getCitizen:        db.prepare('SELECT * FROM citizens WHERE guild_id = ? AND user_id = ?'),
  hasCitizen:        db.prepare('SELECT 1 FROM citizens WHERE guild_id = ? AND user_id = ?'),

  // Bills
  getBill:           db.prepare('SELECT * FROM bills WHERE id = ? AND guild_id = ?'),
  getBillVote:       db.prepare('SELECT * FROM bill_votes WHERE bill_id = ? AND voter_id = ?'),
  getBillConfig:     db.prepare('SELECT quorum, voting_deadline FROM bills WHERE id = ?'),
  castBillVote:      db.prepare('INSERT INTO bill_votes (bill_id, voter_id, vote) VALUES (?, ?, ?)'),
  changeBillVote:    db.prepare('UPDATE bill_votes SET vote = ?, voted_at = unixepoch() WHERE bill_id = ? AND voter_id = ?'),

  // Elections
  getElection:       db.prepare('SELECT * FROM elections WHERE id = ? AND guild_id = ?'),
  getCandidate:      db.prepare('SELECT * FROM candidates WHERE election_id = ? AND user_id = ?'),
  getElectionVote:   db.prepare('SELECT * FROM votes WHERE election_id = ? AND voter_id = ?'),
  getRcvVote:        db.prepare('SELECT * FROM rcv_votes WHERE election_id = ? AND voter_id = ?'),

  // Activity log
  logActivity:       db.prepare('INSERT INTO activity_log (guild_id, action, actor_id, target, details) VALUES (?, ?, ?, ?, ?)'),
  logAdmin:          db.prepare('INSERT INTO admin_log (guild_id, admin_id, action, target, reason, details) VALUES (?, ?, ?, ?, ?, ?)'),
};

// ── Ensure config rows exist for a guild (idempotent) ────────────────────────
export function ensureGuild(guildId) {
  q.upsertConfig.run(guildId);
  q.upsertTreasury.run(guildId);
}

// ── Typed transaction wrapper ────────────────────────────────────────────────
/** Run `fn` inside a BEGIN/COMMIT transaction, returning its result. */
export const tx = fn => db.transaction(fn);

// ── Maintenance ──────────────────────────────────────────────────────────────
const PRUNE_DAYS = 30 * 24 * 3600;

export function pruneOldData() {
  db.prepare('DELETE FROM activity_log WHERE logged_at < unixepoch() - ?').run(PRUNE_DAYS);
  db.prepare('DELETE FROM admin_log    WHERE logged_at < unixepoch() - ?').run(PRUNE_DAYS);
  db.prepare('DELETE FROM treasury_transactions WHERE created_at < unixepoch() - ?').run(PRUNE_DAYS);
  // Hard caps
  db.exec(`
    DELETE FROM activity_log WHERE id NOT IN
      (SELECT id FROM activity_log ORDER BY logged_at DESC LIMIT 100000);
    DELETE FROM admin_log WHERE id NOT IN
      (SELECT id FROM admin_log ORDER BY logged_at DESC LIMIT 50000);
    DELETE FROM treasury_transactions WHERE id NOT IN
      (SELECT id FROM treasury_transactions ORDER BY created_at DESC LIMIT 50000);
  `);
}

export function startMaintenance(intervalHours = 6) {
  setInterval(() => {
    try {
      pruneOldData();
      db.pragma('wal_checkpoint(FULL)');
      console.log('[DB] Maintenance complete');
    } catch (e) {
      console.error('[DB] Maintenance error:', e);
    }
  }, intervalHours * 3_600_000);
}

export default db;
