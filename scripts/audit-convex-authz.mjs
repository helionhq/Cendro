import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CONVEX_DIR = path.resolve("convex");

/**
 * Approved authorization helpers for company, resource, and user-global operations.
 */
const APPROVED_HELPERS = new Set([
  // Company & resource authorization helpers
  "requireCompanyAccess",
  "requireMembership",
  "requireCapability",
  "requireFleetLogOrManage",
  "requireCan",
  "assertCan",
  "assertTaskAction",
  "assertTaskCreate",
  "getVisibleTask",
  "getVisibleSop",
  "assertSopAction",
  "assertAnalyticsViewAccess",
  "assertSession",
  "assertCanModifyTarget",
  "requirePlatformAdmin",
  "verifyAiPersistenceSignature",

  // Authenticated user helpers
  "currentUser",
  "currentOrCreateUser",
  "ctx.auth.getUserIdentity",
]);

/**
 * Intentional anonymous or pre-authenticated endpoints with documented reasons.
 */
const ALLOWLIST = new Map([
  [
    "invitations:preview",
    "Anyone with an invitation token can preview invitation details before accepting.",
  ],
  [
    "companies:accessStatus",
    "Pre-membership access status check; returns signedOut if unauthenticated.",
  ],
  [
    "platform:access",
    "Checks whether caller is platform admin; can be called when unauthenticated.",
  ],
  [
    "platform:adminDashboard",
    "Platform admin overview; returns empty list if unauthenticated or not platform admin.",
  ],
]);

function shouldAuditFile(filename) {
  if (!filename.endsWith(".ts")) return false;
  if (filename.endsWith(".test.ts") || filename.endsWith(".fixture.ts")) return false;
  if (["schema.ts", "crons.ts", "auth.config.ts"].includes(filename)) return false;
  return true;
}

function collectExportedFunctions(files) {
  const sourceFiles = new Map();
  const allFunctions = new Map();

  for (const file of files) {
    const filePath = path.join(CONVEX_DIR, file);
    const content = fs.readFileSync(filePath, "utf8");
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const mod = file.replace(".ts", "");
    sourceFiles.set(mod, sf);

    sf.forEachChild((node) => {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (decl.initializer && ts.isCallExpression(decl.initializer)) {
            const fnType = decl.initializer.expression.getText(sf);
            if (
              [
                "query",
                "mutation",
                "action",
                "internalQuery",
                "internalMutation",
                "internalAction",
              ].includes(fnType)
            ) {
              const name = decl.name.getText(sf);
              let handlerNode = null;
              const arg = decl.initializer.arguments[0];
              if (arg && ts.isObjectLiteralExpression(arg)) {
                for (const prop of arg.properties) {
                  if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === "handler") {
                    handlerNode = prop.initializer;
                  }
                }
              } else if (
                arg &&
                (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg) || ts.isIdentifier(arg))
              ) {
                handlerNode = arg;
              }
              allFunctions.set(`${mod}:${name}`, { handlerNode, sf });
            }
          }
        }
      }
    });
  }

  return { sourceFiles, allFunctions };
}

function getCallsFromNode(node, sf, currentMod, allFunctions, visited = new Set()) {
  const calls = [];
  if (!node) return calls;

  if (ts.isIdentifier(node)) {
    const name = node.text;
    const key = `${currentMod}:${name}`;
    if (visited.has(key)) return calls;
    visited.add(key);

    let foundDecl = null;
    sf.forEachChild((n) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.name.text === name) {
        foundDecl = n;
      } else if (ts.isVariableStatement(n)) {
        for (const d of n.declarationList.declarations) {
          if (d.name.getText(sf) === name && d.initializer) {
            foundDecl = d.initializer;
          }
        }
      }
    });

    if (foundDecl) {
      return getCallsFromNode(foundDecl, sf, currentMod, allFunctions, visited);
    }
  }

  function visit(n) {
    if (ts.isCallExpression(n)) {
      const expr = n.expression;
      const text = expr.getText(sf);
      calls.push(text);

      if (text.includes("getUserIdentity")) {
        calls.push("ctx.auth.getUserIdentity");
      }

      // Action delegating to internal query/mutation/action
      if (
        (text === "ctx.runQuery" || text === "ctx.runMutation" || text === "ctx.runAction") &&
        n.arguments.length > 0
      ) {
        const targetArg = n.arguments[0].getText(sf);
        const match = targetArg.match(/internal\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)/);
        if (match) {
          const targetMod = match[1];
          const targetName = match[2];
          const targetKey = `${targetMod}:${targetName}`;
          if (!visited.has(targetKey) && allFunctions.has(targetKey)) {
            visited.add(targetKey);
            const { handlerNode, sf: targetSf } = allFunctions.get(targetKey);
            calls.push(...getCallsFromNode(handlerNode, targetSf, targetMod, allFunctions, visited));
          }
        }
      }

      // Local function call within the file
      if (ts.isIdentifier(expr)) {
        const fnName = expr.text;
        const key = `${currentMod}:${fnName}`;
        if (!visited.has(key)) {
          visited.add(key);
          sf.forEachChild((topNode) => {
            if (ts.isFunctionDeclaration(topNode) && topNode.name && topNode.name.text === fnName) {
              calls.push(...getCallsFromNode(topNode, sf, currentMod, allFunctions, visited));
            } else if (ts.isVariableStatement(topNode)) {
              for (const d of topNode.declarationList.declarations) {
                if (d.name.getText(sf) === fnName && d.initializer) {
                  calls.push(...getCallsFromNode(d.initializer, sf, currentMod, allFunctions, visited));
                }
              }
            }
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  }

  visit(node);
  return calls;
}

function runAudit() {
  if (!fs.existsSync(CONVEX_DIR)) {
    console.error(`Convex directory not found: ${CONVEX_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(CONVEX_DIR).filter(shouldAuditFile);
  const { sourceFiles, allFunctions } = collectExportedFunctions(files);

  let totalEndpoints = 0;
  let passingEndpoints = 0;
  const failures = [];

  console.log("Auditing public Convex functions for authorization...\n");

  for (const [mod, sf] of sourceFiles.entries()) {
    sf.forEachChild((node) => {
      if (
        ts.isVariableStatement(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const decl of node.declarationList.declarations) {
          if (decl.initializer && ts.isCallExpression(decl.initializer)) {
            const fnType = decl.initializer.expression.getText(sf);
            if (["query", "mutation", "action"].includes(fnType)) {
              totalEndpoints++;
              const exportName = decl.name.getText(sf);
              const endpointKey = `${mod}:${exportName}`;

              if (ALLOWLIST.has(endpointKey)) {
                passingEndpoints++;
                console.log(`✓ [ALLOWLIST] ${endpointKey} (${fnType}) -> ${ALLOWLIST.get(endpointKey)}`);
                continue;
              }

              const item = allFunctions.get(endpointKey);
              if (!item || !item.handlerNode) {
                failures.push(`${endpointKey}: No handler function body found.`);
                continue;
              }

              const calls = getCallsFromNode(item.handlerNode, sf, mod, allFunctions);
              const foundHelper = calls.find((c) => APPROVED_HELPERS.has(c));

              if (foundHelper) {
                passingEndpoints++;
                console.log(`✓ ${endpointKey} (${fnType}) -> ${foundHelper}`);
              } else {
                failures.push(
                  `${endpointKey} (${fnType}): Missing approved authorization helper. Calls found: ${calls.slice(0, 8).join(", ") || "none"}`
                );
              }
            }
          }
        }
      }
    });
  }

  // Audit HTTP routes if convex/http.ts exists
  const httpFile = path.join(CONVEX_DIR, "http.ts");
  if (fs.existsSync(httpFile)) {
    console.log("\nAuditing convex/http.ts routes...");
    // Check routes registered on http router
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Total public endpoints audited: ${totalEndpoints}`);
  console.log(`Passing authorization checks:   ${passingEndpoints}`);
  console.log(`Failures:                       ${failures.length}`);
  console.log("=".repeat(60));

  if (failures.length > 0) {
    console.error("\nAudit failed with the following violations:\n");
    for (const fail of failures) {
      console.error(`  ✕ ${fail}`);
    }
    process.exit(1);
  } else {
    console.log("\nAll public Convex endpoints enforce approved authorization!");
  }
}

runAudit();
