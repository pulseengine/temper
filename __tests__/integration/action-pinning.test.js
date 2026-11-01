import { findTagPinnedActions } from '../../src/action-pinning.js';

const octokit = (files) => ({
  rest: {
    repos: {
      getContent: async ({ path }) => {
        if (path === '.github/workflows') {
          return { data: Object.keys(files).map((name) => ({ name, path: `.github/workflows/${name}` })) };
        }
        const name = path.split('/').pop();
        if (!(name in files)) {
          const err = new Error('Not Found');
          err.status = 404;
          throw err;
        }
        return { data: { content: Buffer.from(files[name]).toString('base64') } };
      }
    }
  }
});

describe('findTagPinnedActions', () => {
  it('flags tag-pinned uses and passes SHA-pinned ones', async () => {
    const client = octokit({
      'ci.yml': [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/checkout@v7',
        '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
        '      - uses: docker://alpine:3.19',
        '      - uses: ./.github/actions/local'
      ].join('\n')
    });
    const findings = await findTagPinnedActions(client, 'pulseengine', 'gale');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'ci.yml', line: 4, action: 'actions/checkout', ref: 'v7' });
  });

  it('returns empty when there are no workflows', async () => {
    const client = octokit({});
    const err = new Error('Not Found');
    err.status = 404;
    client.rest.repos.getContent = async () => {
      throw err;
    };
    await expect(findTagPinnedActions(client, 'o', 'r')).resolves.toEqual([]);
  });
});
