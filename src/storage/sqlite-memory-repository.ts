import { randomBytes } from 'node:crypto';
import type { SqliteAdapter } from './sqlite-adapter.js';
import type {
  ElementObservationRow,
  MemoryEventRow,
  MemoryRepository,
  Observation,
  ObservationResult,
  PageRow,
  PageVersionRow,
  ScopeRow,
  VerificationResult,
} from './repositories.js';
import type { ScopeKey } from '../memory/scope.js';

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v);
const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

function scopeRow(r: Row): ScopeRow {
  return {
    id: num(r.id),
    project: String(r.project),
    origin: String(r.origin),
    environment: String(r.environment),
    authContext: String(r.auth_context),
    createdAt: String(r.created_at),
  };
}
function pageRow(r: Row): PageRow {
  return {
    id: num(r.id),
    scopeId: num(r.scope_id),
    routeKey: String(r.route_key),
    pageKey: String(r.page_key),
    activeVersionId: r.active_version_id === null ? undefined : num(r.active_version_id),
    createdAt: String(r.created_at),
  };
}
function versionRow(r: Row): PageVersionRow {
  return {
    id: num(r.id),
    pageId: num(r.page_id),
    versionNo: num(r.version_no),
    variantKey: String(r.variant_key),
    shapeHash: String(r.shape_hash),
    labelHash: String(r.label_hash),
    buildHint: str(r.build_hint),
    status: String(r.status) as PageVersionRow['status'],
    complete: !!r.complete,
    elementCount: num(r.element_count),
    capped: !!r.capped,
    firstSeenAt: String(r.first_seen_at),
    lastSeenAt: String(r.last_seen_at),
    observations: num(r.observations),
    verifiedAt: str(r.verified_at),
  };
}

/**
 * SQLite Browser Memory repository. Every read and write is bound to a scope id; a page, version or
 * element of another scope is invisible (doc 06 §2.5, doc 11 §3). One transaction per observation and
 * per verification; writes never span a browser action.
 */
export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly db: SqliteAdapter) {}

  upsertScope(s: ScopeKey): number {
    this.db.run(
      'INSERT INTO scopes (project,origin,environment,auth_context,created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',
      s.project,
      s.origin,
      s.environment,
      s.authContext,
      new Date().toISOString(),
    );
    return num(
      this.db.get(
        'SELECT id FROM scopes WHERE project=? AND origin=? AND environment=? AND auth_context=?',
        s.project,
        s.origin,
        s.environment,
        s.authContext,
      )!.id,
    );
  }

  findScope(s: ScopeKey): number | undefined {
    const r = this.db.get(
      'SELECT id FROM scopes WHERE project=? AND origin=? AND environment=? AND auth_context=?',
      s.project,
      s.origin,
      s.environment,
      s.authContext,
    );
    return r ? num(r.id) : undefined;
  }

  projects(): string[] {
    return this.db.all('SELECT DISTINCT project FROM scopes ORDER BY project').map((r) => String(r.project));
  }

  scopes(project: string): ScopeRow[] {
    return this.db
      .all('SELECT * FROM scopes WHERE project=? ORDER BY origin,environment,auth_context', project)
      .map(scopeRow);
  }

  scope(project: string, scopeId: number): ScopeRow | undefined {
    const r = this.db.get('SELECT * FROM scopes WHERE id=? AND project=?', scopeId, project);
    return r ? scopeRow(r) : undefined;
  }

  findPage(scopeId: number, pageKey: string): PageRow | undefined {
    const r = this.db.get('SELECT * FROM pages WHERE scope_id=? AND page_key=?', scopeId, pageKey);
    return r ? pageRow(r) : undefined;
  }

  pages(scopeId: number, limit = 200): Array<PageRow & { versions: number }> {
    return this.db
      .all(
        'SELECT p.*, (SELECT COUNT(*) FROM page_versions v WHERE v.page_id=p.id) AS versions FROM pages p WHERE p.scope_id=? ORDER BY p.route_key LIMIT ?',
        scopeId,
        limit,
      )
      .map((r) => ({ ...pageRow(r), versions: num(r.versions) }));
  }

  pagesByRoute(scopeId: number, routeKey: string): PageRow[] {
    return this.db
      .all('SELECT * FROM pages WHERE scope_id=? AND route_key=?', scopeId, routeKey)
      .map(pageRow);
  }

  versions(scopeId: number, pageId: number, limit = 20): PageVersionRow[] {
    return this.db
      .all(
        'SELECT v.* FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.scope_id=? AND v.page_id=? ORDER BY v.version_no DESC LIMIT ?',
        scopeId,
        pageId,
        limit,
      )
      .map(versionRow);
  }

  version(scopeId: number, versionId: number): PageVersionRow | undefined {
    const r = this.db.get(
      'SELECT v.* FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.scope_id=? AND v.id=?',
      scopeId,
      versionId,
    );
    return r ? versionRow(r) : undefined;
  }

  /** Active version of a page for one variant. */
  activeVersion(scopeId: number, pageId: number, variantKey: string): PageVersionRow | undefined {
    const r = this.db.get(
      "SELECT v.* FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.scope_id=? AND v.page_id=? AND v.variant_key=? AND v.status='active'",
      scopeId,
      pageId,
      variantKey,
    );
    return r ? versionRow(r) : undefined;
  }

  elementsOf(scopeId: number, pageVersionId: number, limit = 1000): ElementObservationRow[] {
    return this.db
      .all(
        `SELECT o.id, e.memory_id, e.semantic_key, e.role, o.fingerprint_json, o.locators_json, o.verified_at
         FROM element_observations o JOIN elements e ON e.id=o.element_id JOIN page_versions v ON v.id=o.page_version_id
         JOIN pages p ON p.id=v.page_id WHERE p.scope_id=? AND o.page_version_id=? ORDER BY o.id LIMIT ?`,
        scopeId,
        pageVersionId,
        limit,
      )
      .map((r) => ({
        id: num(r.id),
        memoryId: String(r.memory_id),
        semanticKey: String(r.semantic_key),
        role: String(r.role),
        fingerprint: JSON.parse(String(r.fingerprint_json)) as ElementObservationRow['fingerprint'],
        locators: JSON.parse(String(r.locators_json)) as ElementObservationRow['locators'],
        verifiedAt: str(r.verified_at),
      }));
  }

  events(scopeId: number, limit = 100): MemoryEventRow[] {
    return this.db
      .all('SELECT * FROM memory_events WHERE scope_id=? ORDER BY id DESC LIMIT ?', scopeId, limit)
      .map((r) => ({
        id: num(r.id),
        ts: String(r.ts),
        actor: String(r.actor),
        kind: String(r.kind),
        subject: String(r.subject),
        detail: JSON.parse(String(r.detail_json)) as Record<string, unknown>,
      }));
  }

  private event(
    project: string,
    scopeId: number | null,
    actor: 'observer' | 'verifier' | 'operator',
    kind: string,
    subject: string,
    detail: Record<string, unknown>,
  ): void {
    this.db.run(
      'INSERT INTO memory_events (project,scope_id,ts,actor,kind,subject,detail_json) VALUES (?,?,?,?,?,?,?)',
      project,
      scopeId,
      new Date().toISOString(),
      actor,
      kind,
      subject,
      JSON.stringify(detail),
    );
  }

  recordObservation(o: Observation): ObservationResult {
    return this.db.transaction(() => {
      let page = this.findPage(o.scopeId, o.pageKey);
      let pageCreated = false;
      if (!page) {
        const count = num(this.db.get('SELECT COUNT(*) AS n FROM pages WHERE scope_id=?', o.scopeId)!.n);
        if (count >= o.maxPagesPerScope) {
          this.event(o.project, o.scopeId, 'observer', 'observation_rejected', 'scope', {
            reason: 'page cap',
            cap: o.maxPagesPerScope,
          });
          return { rejected: 'page cap' };
        }
        this.db.run(
          'INSERT INTO pages (scope_id,route_key,page_key,created_at) VALUES (?,?,?,?)',
          o.scopeId,
          o.routeKey,
          o.pageKey,
          o.at,
        );
        page = this.findPage(o.scopeId, o.pageKey)!;
        pageCreated = true;
        this.event(o.project, o.scopeId, 'observer', 'page_created', `page:${page.id}`, {});
      }
      const active = this.activeVersion(o.scopeId, page.id, o.variantKey);
      const existing = this.db.get(
        'SELECT * FROM page_versions WHERE page_id=? AND variant_key=? AND shape_hash=? AND label_hash=?',
        page.id,
        o.variantKey,
        o.shapeHash,
        o.labelHash,
      );
      if (existing) {
        this.db.run(
          'UPDATE page_versions SET observations=observations+1, last_seen_at=? WHERE id=?',
          o.at,
          num(existing.id),
        );
        const v = versionRow({ ...existing, observations: num(existing.observations) + 1 });
        return { page, version: v, created: false, pageCreated, ...(active ? { active } : {}) };
      }
      const versionNo =
        num(
          this.db.get('SELECT COALESCE(MAX(version_no),0) AS n FROM page_versions WHERE page_id=?', page.id)!
            .n,
        ) + 1;
      const info = this.db.run(
        `INSERT INTO page_versions (page_id,version_no,variant_key,shape_hash,label_hash,build_hint,status,complete,
         element_count,capped,first_seen_at,last_seen_at,observations,supersedes_id) VALUES (?,?,?,?,?,?,'observed',1,?,?,?,?,1,?)`,
        page.id,
        versionNo,
        o.variantKey,
        o.shapeHash,
        o.labelHash,
        o.buildHint ?? null,
        o.elements.length,
        o.capped ? 1 : 0,
        o.at,
        o.at,
        active?.id ?? null,
      );
      const versionId = num(info.lastInsertRowid);
      for (const e of o.elements) {
        this.db.run(
          'INSERT INTO elements (page_id,memory_id,semantic_key,role,created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',
          page.id,
          `el_${randomBytes(8).toString('hex')}`,
          e.semanticKey,
          e.fingerprint.role,
          o.at,
        );
        const el = this.db.get(
          'SELECT id FROM elements WHERE page_id=? AND semantic_key=?',
          page.id,
          e.semanticKey,
        )!;
        this.db.run(
          'INSERT INTO element_observations (element_id,page_version_id,fingerprint_json,fingerprint_hash,locators_json) VALUES (?,?,?,?,?)',
          num(el.id),
          versionId,
          JSON.stringify(e.fingerprint),
          e.hash,
          JSON.stringify(e.locators),
        );
      }
      this.event(o.project, o.scopeId, 'observer', 'version_created', `version:${versionId}`, {
        page: page.id,
        versionNo,
        elements: o.elements.length,
        ...(o.capped ? { capped: true, total: o.totalElements } : {}),
      });
      this.retain(page.id, o.maxVersionsPerPage);
      const version = versionRow(this.db.get('SELECT * FROM page_versions WHERE id=?', versionId)!);
      return { page, version, created: true, pageCreated, ...(active ? { active } : {}) };
    });
  }

  /** Keeps the newest `max` unverified versions of a page; active and verified versions are never deleted. */
  private retain(pageId: number, max: number): void {
    this.db.run(
      `DELETE FROM page_versions WHERE id IN (SELECT id FROM page_versions WHERE page_id=? AND status IN ('observed','candidate','archived','rejected')
       ORDER BY version_no DESC LIMIT -1 OFFSET ?)`,
      pageId,
      max,
    );
    this.db.run(
      'DELETE FROM elements WHERE page_id=? AND NOT EXISTS (SELECT 1 FROM element_observations o WHERE o.element_id=elements.id)',
      pageId,
    );
  }

  markVerified(
    project: string,
    scopeId: number,
    versionId: number,
    semanticKeys: string[],
    at: string,
  ): VerificationResult {
    return this.db.transaction(() => {
      const v = this.version(scopeId, versionId);
      if (!v || !semanticKeys.length) return { marked: 0, activated: false };
      let marked = 0;
      for (const key of semanticKeys) {
        const r = this.db.run(
          `UPDATE element_observations SET verified_at=? WHERE page_version_id=? AND element_id IN
           (SELECT id FROM elements WHERE page_id=? AND semantic_key=?)`,
          at,
          versionId,
          v.pageId,
          key,
        );
        marked += num(r.changes);
      }
      if (!marked) return { marked: 0, activated: false };
      let activated = false;
      if (v.status === 'observed' || v.status === 'candidate') {
        this.db.run("UPDATE page_versions SET status='verified', verified_at=? WHERE id=?", at, versionId);
        this.event(project, scopeId, 'verifier', 'version_verified', `version:${versionId}`, {
          versionNo: v.versionNo,
          elements: marked,
        });
        // Activation rule: verified + complete snapshot, only when the variant has no active version yet.
        // Replacing an active version needs an operator (or Phase 3 reconciliation).
        if (!this.activeVersion(scopeId, v.pageId, v.variantKey)) {
          this.activate(project, scopeId, versionId, 'verifier');
          activated = true;
        }
      } else if (v.verifiedAt === undefined)
        this.db.run('UPDATE page_versions SET verified_at=? WHERE id=?', at, versionId);
      return { marked, activated };
    });
  }

  private activate(
    project: string,
    scopeId: number,
    versionId: number,
    actor: 'verifier' | 'operator',
  ): void {
    const v = this.version(scopeId, versionId);
    if (!v) throw new Error('Version not found in scope');
    const previous = this.activeVersion(scopeId, v.pageId, v.variantKey);
    if (previous && previous.id !== versionId)
      this.db.run("UPDATE page_versions SET status='archived' WHERE id=?", previous.id);
    this.db.run("UPDATE page_versions SET status='active' WHERE id=?", versionId);
    this.db.run('UPDATE pages SET active_version_id=? WHERE id=?', versionId, v.pageId);
    this.event(project, scopeId, actor, 'version_activated', `version:${versionId}`, {
      versionNo: v.versionNo,
      ...(previous && previous.id !== versionId ? { archived: previous.versionNo } : {}),
    });
  }

  /** Operator activation (CLI). Writes a memory event. */
  activateVersion(project: string, scopeId: number, versionId: number): void {
    this.db.transaction(() => this.activate(project, scopeId, versionId, 'operator'));
  }

  /** Operator purge of one scope (or every scope of a project). Returns the number of scopes removed. */
  purge(project: string, scopeId?: number): number {
    return this.db.transaction(() => {
      const ids = (
        scopeId === undefined
          ? this.db.all('SELECT id FROM scopes WHERE project=?', project)
          : this.db.all('SELECT id FROM scopes WHERE project=? AND id=?', project, scopeId)
      ).map((r) => num(r.id));
      for (const id of ids) this.db.run('DELETE FROM scopes WHERE id=?', id);
      if (ids.length)
        this.event(
          project,
          null,
          'operator',
          'scope_purged',
          scopeId === undefined ? 'project' : `scope:${scopeId}`,
          {
            scopes: ids.length,
          },
        );
      return ids.length;
    });
  }
}
