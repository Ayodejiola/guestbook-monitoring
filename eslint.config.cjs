// @ts-check
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
    {
        ignores: ["node_modules/**", "bin/**", "eslint.config.cjs"],
    },
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        rules: {
            // Pulumi programs legitimately return/chain loosely-typed
            // provider outputs in places; keep the signal on real mistakes.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
        },
    },
);
