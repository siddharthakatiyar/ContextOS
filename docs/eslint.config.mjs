import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Documentation pages intentionally render prose and source-code examples
    // directly in JSX. These two React rules misclassify quoted prose and `//`
    // code lines without improving runtime safety.
    rules: {
      'react/no-unescaped-entities': 'off',
      'react/jsx-no-comment-textnodes': 'off'
    }
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts'
  ])
]);

export default eslintConfig;
