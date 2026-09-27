'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');
const { solveBatchDraw } = require('../src/batchDraw');

// 16 页、每帖 2 张 -> 2 帖各 2 张；copies 5、开机 0、损耗 0 -> 每帖需领纸 10 张
const BASE = { totalPages: 16, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
const PREP = { copies: 5, makereadySheets: 0, processWasteRate: 0, sheetsPerPack: 100 };

test('未启用批次领纸：响应不含 batchDraw 字段（原响应完全不变）', () => {
  assert.equal(computeImposition({ ...BASE, materialPrep: PREP }).batchDraw, undefined);
  assert.equal(computeImposition({ ...BASE, materialPrep: PREP, batchDraw: false }).batchDraw, undefined);
  assert.equal(computeImposition({ ...BASE, materialPrep: PREP, batchDraw: null }).batchDraw, undefined);
  const off = computeImposition({
    ...BASE,
    materialPrep: PREP,
    batchDraw: { enabled: false, batches: [{ batchNo: 'A', availableSheets: 10, signatures: 'all' }] },
  });
  assert.equal(off.batchDraw, undefined);
});

test('任务示例：两帖各需 10 张，通用批与仅供第 1 帖的批各 10 张 -> 两帖均无缺口', () => {
  const mk = () => computeImposition({
    ...BASE,
    materialPrep: PREP,
    batchDraw: {
      batches: [
        { batchNo: '通用批', availableSheets: 10, signatures: 'all' },
        { batchNo: '专用批', availableSheets: 10, signatures: [1] },
      ],
    },
  });
  const r = mk();
  const bd = r.batchDraw;
  assert.equal(bd.enabled, true);
  assert.equal(bd.demandSource, 'materialPrep');
  // 需求取自备料逐帖需领纸
  assert.deepEqual(bd.signatures.map((s) => s.requiredSheets), [10, 10]);
  // 专用批（仅第 1 帖）优先领用 -> 通用批留给第 2 帖：两帖均无缺口
  assert.deepEqual(
    bd.signatures.map((s) => [s.drawnSheets, s.shortageSheets]),
    [[10, 0], [10, 0]]
  );
  const special = bd.batches.find((b) => b.batchNo === '专用批');
  const general = bd.batches.find((b) => b.batchNo === '通用批');
  assert.deepEqual(special.allocations, [{ signature: 1, sheets: 10 }]);
  assert.deepEqual(general.allocations, [{ signature: 2, sheets: 10 }]);
  assert.equal(special.remainingSheets, 0);
  assert.equal(general.remainingSheets, 0);
  assert.equal(general.allowedSignatures.length, 2); // "all" 展开为全部帖
  assert.deepEqual(general.allowedSignatures, [1, 2]);
  const t = bd.totals;
  assert.equal(t.feasible, true);
  assert.equal(t.availableSheets, 20);
  assert.equal(t.requiredSheets, 20);
  assert.equal(t.drawnSheets, 20);
  assert.equal(t.shortageSheets, 0);
  assert.equal(t.remainingSheets, 0);
  // 录入顺序对调（通用批先录）结果不变：分配由批次专用性决定，与录入先后无关
  const swapped = computeImposition({
    ...BASE,
    materialPrep: PREP,
    batchDraw: {
      batches: [
        { batchNo: '专用批', availableSheets: 10, signatures: [1] },
        { batchNo: '通用批', availableSheets: 10, signatures: 'all' },
      ],
    },
  });
  const allocByNo = (bd2) => Object.fromEntries(
    bd2.batches.map((b) => [b.batchNo, b.allocations.map((a) => [a.signature, a.sheets])])
  );
  assert.deepEqual(allocByNo(swapped.batchDraw), allocByNo(bd));
});

test('批次拆给多帖、同帖跨批次：逐帖领用明细与逐批剩余正确', () => {
  const r = computeImposition({
    ...BASE,
    materialPrep: PREP,
    batchDraw: {
      batches: [
        { batchNo: 'A', availableSheets: 15, signatures: 'all' },
        { batchNo: 'B', availableSheets: 8, signatures: [1] },
      ],
    },
  });
  const bd = r.batchDraw;
  // 第 1 帖：B（专用，优先）8 张 + A 2 张；第 2 帖：A 10 张
  assert.deepEqual(bd.signatures[0].draws, [
    { batch: 1, batchNo: 'A', sheets: 2 },
    { batch: 2, batchNo: 'B', sheets: 8 },
  ]);
  assert.deepEqual(bd.signatures[1].draws, [{ batch: 1, batchNo: 'A', sheets: 10 }]);
  const [a, b] = bd.batches;
  assert.deepEqual(a.allocations, [
    { signature: 1, sheets: 2 },
    { signature: 2, sheets: 10 },
  ]);
  assert.equal(a.drawnSheets, 12);
  assert.equal(a.remainingSheets, 3);
  assert.deepEqual(b.allocations, [{ signature: 1, sheets: 8 }]);
  assert.equal(b.remainingSheets, 0);
  assert.equal(bd.totals.feasible, true);
  assert.equal(bd.totals.remainingSheets, 3);
});

test('库存不足：总缺口最小（专用批优先，通用批补足），逐帖缺口与逐批剩余明确', () => {
  const r = computeImposition({
    ...BASE,
    materialPrep: PREP,
    batchDraw: {
      batches: [
        { batchNo: '通用批', availableSheets: 10, signatures: 'all' },
        { batchNo: '专用批', availableSheets: 6, signatures: [1] },
      ],
    },
  });
  const bd = r.batchDraw;
  // 专用批 6 张先给第 1 帖，通用批 4 张补第 1 帖、6 张给第 2 帖 -> 第 2 帖缺 4 张
  assert.deepEqual(
    bd.signatures.map((s) => [s.drawnSheets, s.shortageSheets]),
    [[10, 0], [6, 4]]
  );
  assert.equal(bd.totals.feasible, false);
  assert.equal(bd.totals.shortageSheets, 4); // 需求 20 - 库存 16，总缺口最小 = 4
  assert.equal(bd.totals.drawnSheets, 16);
  assert.equal(bd.totals.remainingSheets, 0);
  bd.batches.forEach((b) => assert.equal(b.remainingSheets, 0));
});

test('需求取自备料逐帖需领纸（含开机损耗与过程损耗的逐帖取整）', () => {
  const r = computeImposition({
    ...BASE,
    materialPrep: { copies: 1000, makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 500 },
    batchDraw: { batches: [{ batchNo: 'A', availableSheets: 5000, signatures: 'all' }] },
  });
  // 每帖需领纸 ceil(2010 / 0.97) = 2073（与 materialPrep 段一致）
  assert.deepEqual(r.batchDraw.signatures.map((s) => s.requiredSheets), [2073, 2073]);
  assert.equal(r.batchDraw.totals.drawnSheets, 4146);
  assert.equal(r.batchDraw.totals.remainingSheets, 5000 - 4146);
  assert.equal(r.batchDraw.totals.feasible, true);
});

test('均衡分帖各帖需求不同：按各帖实际需领纸分配', () => {
  // 17 页均衡分帖 -> 各帖实际 [2, 2, 1] 张；copies 10、损耗 0 -> 需求 [20, 20, 10]
  const r = computeImposition({
    ...BASE,
    totalPages: 17,
    balancedSplit: true,
    materialPrep: { copies: 10, makereadySheets: 0, processWasteRate: 0, sheetsPerPack: 100 },
    batchDraw: {
      batches: [
        { batchNo: '末帖专用', availableSheets: 10, signatures: [3] },
        { batchNo: '通用批', availableSheets: 40, signatures: 'all' },
      ],
    },
  });
  const bd = r.batchDraw;
  assert.deepEqual(bd.signatures.map((s) => s.requiredSheets), [20, 20, 10]);
  assert.deepEqual(bd.signatures.map((s) => s.shortageSheets), [0, 0, 0]);
  const special = bd.batches.find((b) => b.batchNo === '末帖专用');
  assert.deepEqual(special.allocations, [{ signature: 3, sheets: 10 }]);
  assert.equal(bd.totals.remainingSheets, 0);
});

test('未启用印刷备料时启用批次领纸：返回明确错误', () => {
  assert.throws(
    () => computeImposition({
      ...BASE,
      batchDraw: { batches: [{ batchNo: 'A', availableSheets: 10, signatures: 'all' }] },
    }),
    /库存批次领纸需要先启用印刷备料/
  );
  // 备料显式关闭同样报错
  assert.throws(
    () => computeImposition({
      ...BASE,
      materialPrep: false,
      batchDraw: { batches: [{ batchNo: 'A', availableSheets: 10, signatures: [1] }] },
    }),
    /印刷备料/
  );
});

test('重复批号：返回明确错误', () => {
  assert.throws(
    () => computeImposition({
      ...BASE,
      materialPrep: PREP,
      batchDraw: {
        batches: [
          { batchNo: 'P001', availableSheets: 10, signatures: [1] },
          { batchNo: 'P001', availableSheets: 20, signatures: [2] },
        ],
      },
    }),
    /批号重复：「P001」/
  );
});

test('无效帖号：越界 / 非整数 / 重复 / 空数组均返回明确错误', () => {
  const mk = (signatures) => () => computeImposition({
    ...BASE,
    materialPrep: PREP,
    batchDraw: { batches: [{ batchNo: 'A', availableSheets: 10, signatures }] },
  });
  assert.throws(mk([3]), /允许帖号 3 超出范围（1 ~ 2）/); // 共 2 帖
  assert.throws(mk([0]), /允许帖号必须为 ≥ 1 的整数/);
  assert.throws(mk([1.5]), /允许帖号必须为 ≥ 1 的整数/);
  assert.throws(mk(['x']), /允许帖号必须为 ≥ 1 的整数/);
  assert.throws(mk([1, 1]), /允许帖号重复：1/);
  assert.throws(mk([]), /不能为空数组/);
  assert.throws(mk(123), /必须为非空数组.*"all"/);
});

test('批次数与批次字段非法：返回明确错误', () => {
  const mk = (batchDraw) => () => computeImposition({ ...BASE, materialPrep: PREP, batchDraw });
  assert.throws(mk({ batches: [] }), /至少录入 1 个/);
  assert.throws(
    mk({
      batches: Array.from({ length: 13 }, (_, i) => ({ batchNo: `B${i}`, availableSheets: 1, signatures: 'all' })),
    }),
    /最多录入 12 个/
  );
  assert.throws(mk({ batches: [{ batchNo: '', availableSheets: 10, signatures: 'all' }] }), /批号 batchNo 不能为空/);
  assert.throws(mk({ batches: [{ batchNo: 'A', availableSheets: 0, signatures: 'all' }] }), /可用张数/);
  assert.throws(mk({ batches: [{ batchNo: 'A', availableSheets: 1.5, signatures: 'all' }] }), /可用张数/);
  assert.throws(mk({ batches: [{ batchNo: 'A', availableSheets: 10 }] }), /允许帖号 signatures 必须为非空数组/);
  assert.throws(mk('x'), /batchDraw 必须为对象/);
  assert.throws(mk({ batches: {} }), /batches 必须为数组/);
  assert.throws(mk({ enabled: 1, batches: [] }), /enabled 必须为布尔值/);
});

test('批次领纸不影响拼版与备料结果（仅追加 batchDraw 段）', () => {
  const plain = computeImposition({ ...BASE, materialPrep: PREP });
  const withDraw = computeImposition({
    ...BASE,
    materialPrep: PREP,
    batchDraw: { batches: [{ batchNo: 'A', availableSheets: 100, signatures: 'all' }] },
  });
  assert.deepEqual(withDraw.signatures, plain.signatures);
  assert.deepEqual(withDraw.materialPrep, plain.materialPrep);
  assert.ok(withDraw.batchDraw);
});

/* ------------------------------ 求解器：暴力对照 ------------------------------ */

/** 可复现的伪随机数（mulberry32）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 暴力枚举各批次在允许帖上的全部分配，返回最小总缺口（与求解器独立）。 */
function bruteForceMinShortage(demands, batches) {
  const m = demands.length;
  const n = batches.length;
  let best = Infinity;
  const alloc = batches.map(() => new Array(m).fill(0));
  const dfs = (bi) => {
    if (bi === n) {
      let shortage = 0;
      for (let g = 0; g < m; g++) {
        let drawn = 0;
        for (let i = 0; i < n; i++) drawn += alloc[i][g];
        shortage += Math.max(0, demands[g] - drawn);
      }
      if (shortage < best) best = shortage;
      return;
    }
    const b = batches[bi];
    const vec = new Array(m).fill(0);
    const gen = (slot, remaining) => {
      if (slot === b.allowed.length) {
        alloc[bi] = vec.slice();
        dfs(bi + 1);
        return;
      }
      const g = b.allowed[slot];
      // 单帖领用超过需求无意义（不会进一步减小缺口），按需求截断以收窄枚举空间
      const cap = Math.min(remaining, demands[g]);
      for (let x = 0; x <= cap; x++) {
        vec[g] = x;
        gen(slot + 1, remaining - x);
      }
      vec[g] = 0;
    };
    gen(0, b.available);
  };
  dfs(0);
  return best;
}

test('求解器随机小实例对照暴力枚举：总缺口恒为最小，且约束全部满足', () => {
  const rand = mulberry32(20260927);
  for (let t = 0; t < 400; t++) {
    const m = 1 + Math.floor(rand() * 3); // 1..3 帖
    const n = 1 + Math.floor(rand() * 3); // 1..3 批
    const demands = Array.from({ length: m }, () => 1 + Math.floor(rand() * 5));
    const batches = Array.from({ length: n }, () => {
      const allowed = [];
      for (let g = 0; g < m; g++) if (rand() < 0.65) allowed.push(g);
      if (allowed.length === 0) allowed.push(Math.floor(rand() * m));
      return { available: 1 + Math.floor(rand() * 5), allowed };
    });
    const { allocations, totalDrawn } = solveBatchDraw(demands, batches);
    assert.equal(allocations.length, n);
    const perSig = new Array(m).fill(0);
    allocations.forEach((allocs, i) => {
      let sum = 0;
      allocs.forEach((a) => {
        assert.ok(batches[i].allowed.includes(a.signature), '只能分给允许的帖');
        assert.ok(a.sheets > 0);
        sum += a.sheets;
        perSig[a.signature] += a.sheets;
      });
      assert.ok(sum <= batches[i].available, '每批领用不得超库存');
    });
    perSig.forEach((drawn, g) => assert.ok(drawn <= demands[g], '同帖领用不超需求'));
    const shortage = demands.reduce((s, d, g) => s + (d - perSig[g]), 0);
    assert.equal(totalDrawn + shortage, demands.reduce((a, b) => a + b, 0));
    assert.equal(shortage, bruteForceMinShortage(demands, batches), `实例 ${t} 总缺口应为最小`);
  }
});

test('求解器确定性：同一输入两次求解结果完全一致', () => {
  const demands = [10, 10, 10];
  const batches = [
    { available: 10, allowed: [0, 1, 2] },
    { available: 10, allowed: [0] },
    { available: 7, allowed: [1, 2] },
  ];
  const first = solveBatchDraw(demands, batches);
  const second = solveBatchDraw(demands, batches);
  assert.deepEqual(first, second);
  // 专用批 [0] 优先 -> 第 1 帖由专用批供给，通用批留给其余帖
  const special = first.allocations[1];
  assert.deepEqual(special, [{ signature: 0, sheets: 10 }]);
});
