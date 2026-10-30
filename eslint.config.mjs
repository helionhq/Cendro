import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
  { ignores: ["convex/_generated/**", ".next/**", "node_modules/**"] },
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "react-hooks/set-state-in-effect": "off",
      "import/no-anonymous-default-export": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "ignoreRestSiblings": true }]
    }
  },
  {
    files: ["convex/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "./_generated/server",
          importNames: ["mutation", "internalMutation"],
          message: "Import mutation builders from ./functions so table triggers run.",
        }],
      }],
    }
  }
];
export default eslintConfig;
