import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import {
  remarkRelativeMdLinks,
  starlightPreset,
} from '@syntax-syllogism/docs-theme';

const BASE = '/sfd/docs';

export default defineConfig({
  site: 'https://syntax-syllogism.com',
  base: BASE,
  outDir: './dist',
  trailingSlash: 'always',
  markdown: {
    remarkPlugins: [[remarkRelativeMdLinks, { base: BASE, docsRoot: '../docs' }]],
  },
  integrations: [
    starlight(
      starlightPreset({
        title: 'sfd',
        base: BASE,
        toolSlug: 'sfd',
        publicRepo: 'Syntax-Syllogism/sfd',
        accent: 'blue',
      }),
    ),
    starlightLinksValidator(),
  ],
});
