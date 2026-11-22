import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecognizedSpdxExpression, validateLicenseField } from "./license.mjs";

test("isRecognizedSpdxExpression handles SPDX operators, + suffixes, LicenseRefs, DocumentRefs, and invalid tokens", () => {
  assert.equal(isRecognizedSpdxExpression(null), false);
  assert.equal(isRecognizedSpdxExpression(42), false);
  assert.equal(isRecognizedSpdxExpression(""), false);
  assert.equal(isRecognizedSpdxExpression("   "), false);
  assert.equal(isRecognizedSpdxExpression("()"), false);
  assert.equal(isRecognizedSpdxExpression("(AND)"), false);
  assert.equal(isRecognizedSpdxExpression("OR MIT"), false);
  assert.equal(isRecognizedSpdxExpression("MIT AND"), false);
  assert.equal(isRecognizedSpdxExpression("MIT WITH"), false);
  assert.equal(isRecognizedSpdxExpression("(MIT WITH)"), false);
  assert.equal(isRecognizedSpdxExpression("(MIT) WITH LLVM-exception"), false);
  assert.equal(isRecognizedSpdxExpression("UnknownId+"), false);
  assert.equal(isRecognizedSpdxExpression("DocumentRef-foo:Other-bar"), false);
  assert.equal(isRecognizedSpdxExpression("DocumentRef-:LicenseRef-bar"), false);

  assert.equal(isRecognizedSpdxExpression("GPL-2.0+"), true);
  assert.equal(isRecognizedSpdxExpression("((MIT and Apache-2.0) or BSD-3-Clause)"), true);
  assert.equal(isRecognizedSpdxExpression("Apache-2.0 with LLVM-exception"), true);
  assert.equal(isRecognizedSpdxExpression("DocumentRef-custom.1:LicenseRef-Enterprise-2.0"), true);
});

test("validateLicenseField formats contextual prefixes for required, empty, and non-SPDX inputs", () => {
  assert.deepEqual(
    validateLicenseField(undefined, { required: true, prefix: "external.json[2]" }),
    {
      errors: ['external.json[2]: "license" is required'],
      warnings: [],
    },
  );

  assert.deepEqual(
    validateLicenseField("   ", { prefix: "plugin.json" }),
    {
      errors: ['plugin.json: "license" must be a non-empty string'],
      warnings: [],
    },
  );

  const custom = validateLicenseField("Commercial License", { prefix: "plugins/acme" });
  assert.deepEqual(custom.errors, []);
  assert.equal(custom.warnings.length, 1);
  assert.match(custom.warnings[0], /^plugins\/acme: "license" value `Commercial License`/);
});
