// The rendered .github/dependabot.yml must validate against SchemaStore's
// dependabot-2.0.json. plant#12 shipped `groups` at the top level, which the
// schema forbids (additionalProperties: false) and Dependabot rejects.
//
// Vendored schema: https://json.schemastore.org/dependabot-2.0.json, fetched
// 2026-11-25, sha256 891027089ecaeaf235ba78fa6ec255542a49465e6cb71ffb92606a2d9edbc1ea.

import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import yaml from 'js-yaml';
import { buildDependabotYaml } from '../../src/dependabot.js';

const root = process.cwd();
const schema = JSON.parse(
  fs.readFileSync(path.join(root, '__tests__/fixtures/dependabot-2.0.schema.json'), 'utf8')
);
const validate = new Ajv({ allErrors: true, schemaId: 'auto' }).compile(schema);
const genConfig = yaml.load(fs.readFileSync(path.join(root, 'config.yml'), 'utf8')).dependabot_generation;

// Render exactly as applyDependabotConfig does, then parse the file back.
const rendered = (config) => yaml.load(yaml.dump(config, { noRefs: true }));

const ECOSYSTEMS = [
  { ecosystem: 'cargo', directory: '/' },
  { ecosystem: 'github-actions', directory: '/' },
  { ecosystem: 'npm', directory: '/web' }
];

describe('generated dependabot.yml against the SchemaStore schema', () => {
  it('validates with the deployed config.yml settings', () => {
    const file = rendered(buildDependabotYaml(ECOSYSTEMS, genConfig));
    expect(validate(file) ? [] : validate.errors).toEqual([]);
  });

  it('validates with the built-in defaults', () => {
    const file = rendered(buildDependabotYaml(ECOSYSTEMS));
    expect(validate(file) ? [] : validate.errors).toEqual([]);
  });

  it('carries the fleet template on every entry: monthly, 2 open PRs, 7-day cooldown', () => {
    const file = rendered(buildDependabotYaml(ECOSYSTEMS, genConfig));
    for (const u of file.updates) {
      expect(u.schedule.interval).toBe('monthly');
      expect(u['open-pull-requests-limit']).toBe(2);
      expect(u.cooldown).toEqual({ 'default-days': 7 });
    }
    expect(file).not.toHaveProperty('groups');
  });

  // Negative control: the schema check must fail on the plant#12 shape.
  it('rejects top-level groups (the plant#12 file)', () => {
    const file = rendered(buildDependabotYaml(ECOSYSTEMS, genConfig));
    const broken = {
      version: 2,
      groups: { 'github-actions-all': { 'package-ecosystem': 'github-actions', patterns: ['*'] } },
      updates: file.updates.map((u) => {
        const { groups: _moved, ...rest } = u; // eslint-disable-line no-unused-vars
        return rest;
      })
    };
    expect(validate(broken)).toBe(false);
    expect(validate.errors.some((e) => e.keyword === 'additionalProperties'
      && e.params.additionalProperty === 'groups')).toBe(true);
  });

  it('rejects package-ecosystem inside a per-entry group', () => {
    const file = rendered(buildDependabotYaml(ECOSYSTEMS, genConfig));
    file.updates[1].groups['github-actions-all']['package-ecosystem'] = 'github-actions';
    expect(validate(file)).toBe(false);
  });
});
