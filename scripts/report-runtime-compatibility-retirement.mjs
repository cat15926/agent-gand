const { inspectRuntimeCompatibilityInventory } = await import('../apps/server/src/runtime/compatibility.ts');
const { closeDatabase } = await import('../apps/server/src/db/database.ts');

try {
  const inventory = inspectRuntimeCompatibilityInventory();
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  if (!inventory.readyForCompatibilityRemoval) process.exitCode = 2;
} finally {
  closeDatabase();
}
