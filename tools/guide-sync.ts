import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

// This explicit update step reads Aria's checkout. Normal builds consume the
// versioned package below and never require that checkout on the NAS or in CI.
const source = resolve(process.argv[2] || process.env.ARIA_SOURCE_DIR || '');
if (!process.argv[2] && !process.env.ARIA_SOURCE_DIR)
  throw new Error('Usage: bun run guide:sync <Aria checkout>');
const guide = join(source, 'agent/src/primitives/guide/index.ts');
if (!(await Bun.file(guide).exists())) throw new Error('Aria Guide public entry point not found.');
const temporary = await mkdtemp(join(tmpdir(), 'aria-guide-package-'));
const staging = join(temporary, 'package');
const vendor = resolve('vendor');
await mkdir(staging);
await mkdir(vendor, { recursive: true });
const run = async (cmd: string[], cwd = source) => {
  const child = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (code) throw new Error(stderr || stdout || 'Guide packaging failed.');
  return stdout.trim();
};
try {
  const revision = await run(['git', 'rev-parse', 'HEAD']);
  const dirty = Boolean(await run(['git', 'status', '--porcelain']));
  const ariaVersion = z
    .object({ version: z.string().min(1) })
    .parse(await Bun.file(join(source, 'package.json')).json()).version;
  const exportFile = join(temporary, 'export.ts');
  const snapshotFile = join(temporary, 'snapshot.json');
  await Bun.write(
    exportFile,
    `
import { renderGuidePagesForDialect } from ${JSON.stringify(guide)};
import { renderDialectText } from ${JSON.stringify(join(source, 'agent/src/primitives/dialect/index.ts'))};
import { BUILTIN_FUNCTION_SCHEMAS_GUIDE } from ${JSON.stringify(join(source, 'agent/src/tools/builtin/schemas/guide.ts'))};
import { toolPrompt } from ${JSON.stringify(join(source, 'agent/src/tools/prompts/guide/query.ts'))};
const pages = renderGuidePagesForDialect(undefined, {dev:false}).map(page => ({
  slug:page.slug, title:page.title, summary:page.summary, content:page.content,
  section:page.section, order:page.order, tags:page.tags, aliases:page.aliases,
  related:page.related, references:page.references, relationships:page.relationships,
  requiresFeatures:page.requiresFeatures, featureStates:page.featureStates, sourcePath:''
}));
await Bun.write(${JSON.stringify(snapshotFile)}, JSON.stringify({pages,
  tool:JSON.parse(renderDialectText(JSON.stringify(BUILTIN_FUNCTION_SCHEMAS_GUIDE[0]))),
  prompt:JSON.parse(renderDialectText(JSON.stringify(toolPrompt)))
}));
`
  );
  await run([process.execPath, exportFile]);
  const snapshot = z
    .object({
      pages: z
        .array(
          z
            .object({
              slug: z.string(),
              title: z.string(),
              summary: z.string(),
              content: z.string(),
              section: z.string(),
              tags: z.array(z.string()),
              aliases: z.array(z.string()),
              related: z.array(z.string()),
              references: z.array(z.unknown()),
              relationships: z.array(z.unknown())
            })
            .passthrough()
        )
        .min(1)
        .max(1000),
      tool: z.object({ name: z.literal('GuideQuery') }).passthrough(),
      prompt: z.record(z.string(), z.unknown())
    })
    .parse(await Bun.file(snapshotFile).json());
  const db = new Database(join(staging, 'guide.sqlite'), { create: true });
  db.exec(`PRAGMA journal_mode=DELETE;
    CREATE TABLE guide_pages (slug TEXT PRIMARY KEY, title TEXT NOT NULL,
      summary TEXT NOT NULL, section TEXT NOT NULL, tags TEXT NOT NULL,
      aliases TEXT NOT NULL, related TEXT NOT NULL, references_json TEXT NOT NULL,
      relationships TEXT NOT NULL, content TEXT NOT NULL, page_json TEXT NOT NULL);
    CREATE VIRTUAL TABLE guide_fts USING fts5(slug UNINDEXED,title,tags,aliases,
      references_json,relationships,summary,content,tokenize='porter unicode61');`);
  const insert = db.query('INSERT INTO guide_pages VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const index = db.query('INSERT INTO guide_fts VALUES (?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const page of snapshot.pages) {
      const tags = JSON.stringify(page.tags),
        aliases = JSON.stringify(page.aliases);
      const references = JSON.stringify(page.references),
        relationships = JSON.stringify(page.relationships);
      insert.run(
        page.slug,
        page.title,
        page.summary,
        page.section,
        tags,
        aliases,
        JSON.stringify(page.related),
        references,
        relationships,
        page.content,
        JSON.stringify(page)
      );
      index.run(
        page.slug,
        page.title,
        tags,
        aliases,
        references,
        relationships,
        page.summary,
        page.content
      );
    }
    db.exec("INSERT INTO guide_fts(guide_fts) VALUES ('optimize')");
  })();
  db.close();
  const entry = join(temporary, 'engine.ts');
  await Bun.write(
    entry,
    `
import { executeGuideQuery, type GuidePage } from ${JSON.stringify(guide)};
import { normalizeGuideQueryInput } from ${JSON.stringify(join(source, 'agent/src/tools/builtin/guide/input.ts'))};
export function query(input:unknown, pages:GuidePage[], database:{searchFts(query:string):Array<{slug:string;title:string;rank:number}>}) {
  return executeGuideQuery(normalizeGuideQueryInput(input), {pages,searchDatabase:()=>database});
}
`
  );
  const build = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    packages: 'bundle',
    define: { __ARIA_VERSION__: JSON.stringify(ariaVersion) }
  });
  if (!build.success) throw new AggregateError(build.logs, 'Native Guide bundle failed.');
  await Bun.write(join(staging, 'index.js'), build.outputs[0]);
  await Bun.write(
    join(staging, 'index.d.ts'),
    `export function query(input: unknown, pages: unknown[], database: {searchFts(query: string): Array<{slug: string; title: string; rank: number}>}): unknown;\n`
  );
  const hash = async (file: string) =>
    new Bun.CryptoHasher('sha256')
      .update(await Bun.file(join(staging, file)).arrayBuffer())
      .digest('hex');
  const manifest = {
    ariaVersion,
    revision,
    dirty,
    pages: snapshot.pages.length,
    runtime: 'bun@1.4.3',
    files: { 'index.js': await hash('index.js'), 'guide.sqlite': await hash('guide.sqlite') },
    tool: snapshot.tool,
    prompt: snapshot.prompt
  };
  await Bun.write(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const snapshotDigest = await hash('manifest.json');
  const version = `0.0.0-${revision.slice(0, 8)}.${snapshotDigest.slice(0, 16)}`;
  const filename = `aria-guide-${version}.tgz`;
  await Bun.write(
    join(staging, 'package.json'),
    JSON.stringify(
      {
        name: '@shane/aria-guide',
        version,
        type: 'module',
        main: './index.js',
        types: './index.d.ts',
        exports: {
          '.': { types: './index.d.ts', default: './index.js' },
          './manifest.json': './manifest.json',
          './guide.sqlite': './guide.sqlite',
          './package.json': './package.json'
        },
        files: ['index.js', 'index.d.ts', 'guide.sqlite', 'manifest.json']
      },
      null,
      2
    )
  );
  await run([process.execPath, 'pm', 'pack', '--destination', temporary], staging);
  const packages = [...new Bun.Glob('*.tgz').scanSync(temporary)];
  if (packages.length !== 1) throw new Error('Expected one Guide package.');
  await Bun.write(join(vendor, filename + '.tmp'), Bun.file(join(temporary, packages[0])));
  await rename(join(vendor, filename + '.tmp'), join(vendor, filename));
  await run([process.execPath, 'add', `./vendor/${filename}`], process.cwd());
  for (const old of new Bun.Glob('aria-guide*.tgz').scanSync(vendor))
    if (old !== filename) await rm(join(vendor, old));
  await Bun.write(
    join(vendor, 'aria-guide.json'),
    JSON.stringify(
      { revision, dirty, version, filename, pages: manifest.pages, files: manifest.files },
      null,
      2
    ) + '\n'
  );
  console.log(
    `Packaged native GuideQuery and ${manifest.pages} public pages at ${revision.slice(0, 8)}${dirty ? ' (working-tree snapshot)' : ''}.`
  );
  console.log('Installed the versioned Guide package and updated bun.lock.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
