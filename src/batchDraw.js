'use strict';

/**
 * 库存批次领纸（inventory batch draw）。
 *
 * 在印刷备料（materialPrep）算出各帖需领纸 requiredSheets 后，把库存纸按
 * 「批次」分配给各帖：用户录入 1～12 个批次的批号、可用张数与允许使用的帖号，
 * 系统求**总缺口最小**的领用方案。
 *
 * 规则：
 * - 各帖需求 = materialPrep.signatures 的 requiredSheets（逐帖取整后的需领纸）；
 * - 批次可拆给多帖、同帖可跨批次；
 * - 每批领用合计不得超过其可用张数（库存），且只能分给允许使用的帖；
 * - 目标：全部帖的缺口合计最小（= 各帖需求合计 − 最大可分配总量，即最大流）；
 * - 分配顺序：允许帖数更少（更专用）的批次优先领用，并列时录入顺序在前者优先
 *   ——尽量把通用批的库存留给后面的帖；仅在能进一步减小总缺口时才通过
 *   增广路径改道（例如两帖各需 10 张，通用批与仅供第 1 帖的批各 10 张时，
 *   专用批分给第 1 帖、通用批分给第 2 帖，两帖均无缺口）。
 *
 * 输入（API 字段 batchDraw，缺省 / null / false / { enabled: false } 时整个模块不启用）：
 * - batches[]  批次列表（1 ~ MAX_BATCHES 个），每个批次：
 *   - batchNo          批号（非空字符串，同次请求内不可重复）；
 *   - availableSheets  可用张数（≥1 的整数，即该批库存）；
 *   - signatures       允许使用的帖号：非空数组（1 ~ 帖数的整数，不可重复），
 *                      或字符串 "all" 表示全部帖通用。
 *
 * 启用本模块必须同时启用印刷备料（materialPrep），否则返回明确错误；
 * 重复批号、无效帖号（非整数 / 越界 / 重复 / 空数组）同样返回明确错误。
 *
 * 输出（顶层 batchDraw 段）：逐帖列出批次领用明细与缺口，逐批列出领用合计与
 * 剩余张数，totals 汇总库存 / 需求 / 领用 / 缺口 / 剩余与 feasible（是否无缺口）。
 * 未启用时 parse 返回 { enabled: false }，attachBatchDraw 不写入任何字段，
 * 原响应完全不变。
 */

const MAX_BATCHES = 12;               // 批次数上限
const MAX_AVAILABLE_SHEETS = 100000000; // 单批可用张数上限 1 亿
const MAX_BATCH_NO_LEN = 50;          // 批号长度上限

/**
 * 解析整数参数：接受整数或纯数字字符串，布尔 / null / 空串等返回 NaN。
 * 与拼版核心 / 备料模块的 toInteger 保持一致语义。
 */
function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * 解析并校验库存批次领纸输入（帖号范围在 attach 阶段结合拼版结果校验）。
 * @returns {{enabled: false} | {enabled: true, batches: Array}}
 */
function parseBatchDrawInput(input) {
  const raw = input && input.batchDraw;
  if (raw === undefined || raw === null || raw === false) {
    return { enabled: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('库存批次领纸参数 batchDraw 必须为对象（含 batches 批次列表）');
  }
  if (raw.enabled === false) {
    return { enabled: false };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('库存批次领纸开关 enabled 必须为布尔值（true / false）');
  }

  if (!Array.isArray(raw.batches)) {
    throw new Error('库存批次 batches 必须为数组（每个批次含 batchNo / availableSheets / signatures）');
  }
  if (raw.batches.length < 1) {
    throw new Error('库存批次至少录入 1 个（批号 / 可用张数 / 允许帖号）');
  }
  if (raw.batches.length > MAX_BATCHES) {
    throw new Error(`库存批次最多录入 ${MAX_BATCHES} 个（收到 ${raw.batches.length} 个）`);
  }

  const batches = raw.batches.map((b, i) => {
    const where = `第 ${i + 1} 个批次`;
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      throw new Error(`${where}必须为对象（批号 / 可用张数 / 允许帖号）`);
    }
    const batchNo = typeof b.batchNo === 'string' ? b.batchNo.trim() : '';
    if (batchNo === '') {
      throw new Error(`${where}批号 batchNo 不能为空`);
    }
    if (batchNo.length > MAX_BATCH_NO_LEN) {
      throw new Error(`${where}批号长度不能超过 ${MAX_BATCH_NO_LEN} 个字符`);
    }
    const availableSheets = toInteger(b.availableSheets);
    if (!Number.isInteger(availableSheets) || availableSheets < 1 || availableSheets > MAX_AVAILABLE_SHEETS) {
      throw new Error(`${where}（「${batchNo}」）可用张数 availableSheets 必须为 1 ~ ${MAX_AVAILABLE_SHEETS.toLocaleString('en-US')} 的整数`);
    }
    // 允许帖号：非空整数数组（去重校验后升序），或 "all" 表示全部帖通用；
    // 帖号上界（1 ~ 实际帖数）在 attach 阶段结合拼版结果校验。
    let signatures;
    if (b.signatures === 'all') {
      signatures = 'all';
    } else if (Array.isArray(b.signatures)) {
      if (b.signatures.length === 0) {
        throw new Error(`${where}（「${batchNo}」）允许帖号 signatures 不能为空数组（至少 1 个帖号，或 "all" 表示全部帖通用）`);
      }
      const seen = new Set();
      signatures = b.signatures.map((v) => {
        const n = toInteger(v);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`${where}（「${batchNo}」）允许帖号必须为 ≥ 1 的整数（收到非法值：${JSON.stringify(v)}）`);
        }
        if (seen.has(n)) {
          throw new Error(`${where}（「${batchNo}」）允许帖号重复：${n}`);
        }
        seen.add(n);
        return n;
      });
      signatures.sort((a, b2) => a - b2);
    } else {
      throw new Error(`${where}（「${batchNo}」）允许帖号 signatures 必须为非空数组（如 [1, 2]）或 "all"（全部帖通用）`);
    }
    return { index: i + 1, batchNo, availableSheets, signatures };
  });

  // 批号同次请求内不可重复：批号与库存一一对应，重复录入会导致库存被重复计算。
  const seenNo = new Set();
  batches.forEach((b) => {
    if (seenNo.has(b.batchNo)) {
      throw new Error(`批号重复：「${b.batchNo}」（同一批次的库存请合并为一条录入）`);
    }
    seenNo.add(b.batchNo);
  });

  return { enabled: true, batches };
}

/**
 * 库存批次领纸求解（纯函数，独立可测）。
 *
 * 以「源 → 批次（容量 = 可用张数）→ 帖（仅允许的帖有边）→ 汇（容量 = 需求张数）」
 * 的网络求最大流，总缺口 = 需求合计 − 最大流，保证总缺口最小。
 * 源点出边按「允许帖数少（更专用）→ 录入顺序在前」的批次优先级顺序加入，
 * 批次到帖的边按帖号升序加入，BFS 按加边顺序探索——同等缺口下优先领用
 * 更专用的批次、优先满足帖号在前的帖，结果唯一确定。
 *
 * @param {number[]} demands 各帖需求张数（≥0 的整数，下标 0 对应第 1 帖）
 * @param {Array<{available:number, allowed:number[]}>} batches
 *        批次（与录入同序；allowed 为 0 起始的帖号下标，升序）
 * @returns {{allocations: Array<Array<{signature:number, sheets:number}>>, totalDrawn: number}}
 *          allocations[i] 为第 i 个批次（与传入同序）分给各帖的张数
 *          （signature 为 0 起始下标，升序，仅列出 > 0 的项）
 */
function solveBatchDraw(demands, batches) {
  const m = demands.length;
  const n = batches.length;
  // 规范化：允许帖号统一升序（BFS 加边顺序与输出顺序均确定）。
  const norm = batches.map((b) => ({
    available: b.available,
    allowed: b.allowed.slice().sort((x, y) => x - y),
  }));
  // 批次优先级：允许帖数更少（更专用）者优先，并列时录入顺序在前者优先。
  const order = norm
    .map((_, i) => i)
    .sort((a, b) => norm[a].allowed.length - norm[b].allowed.length || a - b);

  // 节点编号：0 = 源，1..n = 批次，n+1..n+m = 帖，n+m+1 = 汇。
  const S = 0;
  const T = n + m + 1;
  const graph = Array.from({ length: T + 1 }, () => []);
  const addEdge = (from, to, cap) => {
    const fwd = { to, rev: graph[to].length, cap };
    const rev = { to: from, rev: graph[from].length, cap: 0 };
    graph[from].push(fwd);
    graph[to].push(rev);
    return fwd;
  };
  // 源 → 批次：按优先级顺序加边（BFS 按加边顺序探索，专用批先领）。
  order.forEach((bi) => addEdge(S, 1 + bi, norm[bi].available));
  // 批次 → 帖：仅允许的帖，帖号升序加边。
  const allocEdge = norm.map((b, bi) => {
    const edges = new Map();
    b.allowed.forEach((g) => {
      edges.set(g, addEdge(1 + bi, n + 1 + g, Number.POSITIVE_INFINITY));
    });
    return edges;
  });
  // 帖 → 汇：容量 = 需求张数（同帖可跨批次，但领用合计不超过需求）。
  for (let g = 0; g < m; g++) {
    addEdge(n + 1 + g, T, demands[g]);
  }

  // Edmonds-Karp：BFS 找最短增广路；探索顺序由加边顺序确定，结果唯一。
  for (;;) {
    const prevNode = new Array(T + 1).fill(-1);
    const prevEdge = new Array(T + 1).fill(-1);
    prevNode[S] = S;
    const queue = [S];
    let head = 0;
    while (head < queue.length && prevNode[T] === -1) {
      const u = queue[head];
      head += 1;
      const edges = graph[u];
      for (let e = 0; e < edges.length; e++) {
        const edge = edges[e];
        if (edge.cap > 0 && prevNode[edge.to] === -1) {
          prevNode[edge.to] = u;
          prevEdge[edge.to] = e;
          queue.push(edge.to);
          if (edge.to === T) break;
        }
      }
    }
    if (prevNode[T] === -1) break; // 无增广路：已达最大流（总缺口最小）
    let bottleneck = Number.POSITIVE_INFINITY;
    for (let v = T; v !== S; v = prevNode[v]) {
      bottleneck = Math.min(bottleneck, graph[prevNode[v]][prevEdge[v]].cap);
    }
    for (let v = T; v !== S; v = prevNode[v]) {
      const edge = graph[prevNode[v]][prevEdge[v]];
      edge.cap -= bottleneck;
      graph[v][edge.rev].cap += bottleneck;
    }
  }

  // 批次 → 帖边上的流量 = 反向边容量；按帖号升序输出。
  let totalDrawn = 0;
  const allocations = norm.map((b, bi) => {
    const allocs = [];
    b.allowed.forEach((g) => {
      const edge = allocEdge[bi].get(g);
      const flow = graph[edge.to][edge.rev].cap;
      if (flow > 0) {
        allocs.push({ signature: g, sheets: flow });
        totalDrawn += flow;
      }
    });
    return allocs;
  });
  return { allocations, totalDrawn };
}

/**
 * 依据印刷备料结果（各帖需领纸）执行库存批次领纸分配并附加汇总。
 * 仅在 parseBatchDrawInput 返回 enabled 时调用；否则不写入任何字段。
 *
 * @param {object} result 拼版计算结果（读取帖数）
 * @param {{enabled:false}|{enabled:true, batches:Array}} parsed
 * @param {object|undefined} materialPrepResult 印刷备料结果（未启用备料时为 undefined）
 * @returns {object|undefined} 库存批次领纸结果（batchDraw 段）
 */
function attachBatchDraw(result, parsed, materialPrepResult) {
  if (!parsed || !parsed.enabled) return undefined;
  if (!materialPrepResult || !materialPrepResult.enabled) {
    throw new Error('库存批次领纸需要先启用印刷备料（materialPrep）：各帖需求取自备料逐帖需领纸 requiredSheets');
  }

  const signatureCount = result.signatureCount;
  // 展开 "all"（全部帖通用）并校验帖号范围（无效帖号报明确错误）。
  const batches = parsed.batches.map((b) => {
    const allowed = b.signatures === 'all'
      ? Array.from({ length: signatureCount }, (_, i) => i + 1)
      : b.signatures;
    allowed.forEach((s) => {
      if (s > signatureCount) {
        throw new Error(`第 ${b.index} 个批次（「${b.batchNo}」）允许帖号 ${s} 超出范围（1 ~ ${signatureCount}）`);
      }
    });
    return { ...b, allowed }; // allowed：1 起始帖号，升序
  });

  // 各帖需求 = 备料逐帖需领纸 requiredSheets（顺序与 materialPrep.signatures 一致）。
  const demands = materialPrepResult.signatures.map((row) => row.requiredSheets);
  const { allocations } = solveBatchDraw(
    demands,
    batches.map((b) => ({ available: b.availableSheets, allowed: b.allowed.map((s) => s - 1) }))
  );

  const batchRows = batches.map((b, i) => {
    const drawnSheets = allocations[i].reduce((sum, a) => sum + a.sheets, 0);
    return {
      index: b.index,
      batchNo: b.batchNo,
      availableSheets: b.availableSheets,
      allowedSignatures: b.allowed,
      drawnSheets,
      remainingSheets: b.availableSheets - drawnSheets,
      allocations: allocations[i].map((a) => ({ signature: a.signature + 1, sheets: a.sheets })),
    };
  });

  // 逐帖领用明细（按批次录入顺序列出）。
  const drawsBySig = Array.from({ length: signatureCount }, () => []);
  batchRows.forEach((br) => {
    br.allocations.forEach((a) => {
      drawsBySig[a.signature - 1].push({ batch: br.index, batchNo: br.batchNo, sheets: a.sheets });
    });
  });
  const signatureRows = materialPrepResult.signatures.map((row, g) => {
    const draws = drawsBySig[g];
    const drawnSheets = draws.reduce((sum, d) => sum + d.sheets, 0);
    return {
      signature: row.signature,
      requiredSheets: row.requiredSheets,
      drawnSheets,
      shortageSheets: row.requiredSheets - drawnSheets,
      draws,
    };
  });

  const totals = {
    batchCount: batchRows.length,
    signatureCount,
    availableSheets: batchRows.reduce((sum, r) => sum + r.availableSheets, 0),
    requiredSheets: signatureRows.reduce((sum, r) => sum + r.requiredSheets, 0),
    drawnSheets: signatureRows.reduce((sum, r) => sum + r.drawnSheets, 0),
    shortageSheets: signatureRows.reduce((sum, r) => sum + r.shortageSheets, 0),
    remainingSheets: batchRows.reduce((sum, r) => sum + r.remainingSheets, 0),
  };
  totals.feasible = totals.shortageSheets === 0;

  return {
    enabled: true,
    demandSource: 'materialPrep',
    rule: '总缺口最小（最大流）：批次可拆给多帖、同帖可跨批次；每批领用不超过可用张数且只能分给允许的帖；同等缺口下允许帖数更少（更专用）的批次优先领用，并列时录入顺序在前者优先',
    batches: batchRows,
    signatures: signatureRows,
    totals,
  };
}

module.exports = {
  parseBatchDrawInput,
  solveBatchDraw,
  attachBatchDraw,
  MAX_BATCHES,
};
