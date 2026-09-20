import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // T-1726: the same rules `tests/ui_rules.test.ts` enforces, said in the editor while the line
    // is being written. The test is the gate — it reads every file and holds the allow-list —
    // and these are the ones ESLint can see from the syntax tree alone. `components/ui` is where
    // a control is built, so the controls are refused everywhere else.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**"],
    rules: {
      // A warning, not an error: `tests/ui_rules.test.ts` is the gate and holds the allow-list of
      // what is already here, which ESLint has no way to express. This says it in the editor on
      // the line being written, without turning 108 known lines into a red build.
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "JSXOpeningElement > JSXIdentifier[name=/^(button|input|select|textarea|table)$/]",
          message:
            "Use the shared control from components/ui: a page does not hand-make a control (UI-16).",
        },
        {
          selector: "JSXAttribute[name.name='style']",
          message: "Use a token class: a size and a colour come from the scale (UI-01).",
        },
        {
          selector: "JSXAttribute[name.name='autoFocus']",
          message: "Do not take focus on arrival: it moves a screen reader mid-sentence (UI-01).",
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Markup is never built from a string (PF-50).",
        },
        {
          selector:
            "CallExpression[callee.object.name='window'][callee.property.name=/^(confirm|alert|open)$/]",
          message:
            "Ask with the shared dialog, and open a link with an anchor that carries rel (UI-16, PF-50).",
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  }
);
