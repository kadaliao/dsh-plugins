/**
 * App logos: each catalog app is shown with its vendor's own logo
 * (`logos/<name>.png`, 128 px, square; the page rounds the corners). Apps
 * without one, such as the custom servers, keep their letter tile.
 *
 * Sources: the App Store icon where the vendor ships an app, otherwise the
 * logo from the vendor's site or repository, or the Simple Icons mark (CC0)
 * in the brand colour. The logos are the trademarks of their owners and are
 * used only to identify each service.
 *
 * @module @kadaliao/dsh-bots/lib/logos
 */

/** Catalog app id → logo file name (without `.png`). */
export const LOGOS = {
  playwright: 'playwright',
  exa: 'exa',
  tavily: 'tavily',
  'brave-search': 'brave',
  firecrawl: 'firecrawl',
  github: 'github',
  git: 'git',
  context7: 'context7',
  sentry: 'sentry',
  notion: 'notion',
  memory: 'mcp',
  sqlite: 'sqlite',
  postgres: 'postgres',
  amap: 'amap',
  'baidu-map': 'baidu-map',
  slack: 'slack',
  telegram: 'telegram',
  discord: 'discord',
  feishu: 'feishu',
  stripe: 'stripe',
  hubspot: 'hubspot',
  supabase: 'supabase',
};

/** Logos used outside the app catalog (the featured skill source). */
const OTHER = ['anthropic'];

const NAME_RE = /^[a-z0-9-]{1,40}$/;

/** Whether `name` is a logo file name the plugin may serve. */
export const isLogoName = (name) => NAME_RE.test(String(name ?? '')) && (Object.values(LOGOS).includes(name) || OTHER.includes(name));

/** A catalog entry with its `logo` file name, when it has one. */
export function withLogo(entry) {
  const logo = LOGOS[entry?.id];
  return logo ? { ...entry, logo } : entry;
}
