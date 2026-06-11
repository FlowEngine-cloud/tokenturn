/**
 * The canonical tag SQL fragments (spec 7b), defined once and imported
 * everywhere a query filters or flags by tag. Tags live on identities, not
 * on facts: a fact's tags are its identity's CURRENT tags, which is exactly
 * why a key rename re-tags the key's full history retroactively.
 */

/**
 * An identity's effective tags: vendor tags (mirror the key name, overwritten
 * every sync - a rename re-tags) UNION manual tags (Resolve decisions, they
 * survive sync).
 */
export function effectiveTagsSql(identityAlias: string): string {
  return `(${identityAlias}.tags || ${identityAlias}.manual_tags)`;
}

/**
 * WHERE fragment: the spend fact's identity carries the tag. `tagExpr` is a
 * placeholder ($n) or a column reference. Filters any fact query by tag,
 * across all employees and keys.
 */
export function factTagFilterSql(factAlias: string, tagExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM identities tfi
    WHERE tfi.id = ${factAlias}.identity_id
      AND ${tagExpr} = ANY ${effectiveTagsSql("tfi")})`;
}

/**
 * Boolean expression: does this fact count toward personal usage? False when
 * any effective tag of its identity is toggled off (spec 7b: batch jobs,
 * cron keys, experiments). Facts with no identity count.
 */
export function countsPersonalSql(factAlias: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM identities cpi
    JOIN tag_settings cpt
      ON NOT cpt.counts_personal AND cpt.tag = ANY ${effectiveTagsSql("cpi")}
    WHERE cpi.id = ${factAlias}.identity_id)`;
}
