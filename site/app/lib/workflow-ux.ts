export type GuidanceBatch = {
  id: string;
  product: string;
  passedReviews: number;
  isStale?: boolean;
};

export type NextActionKind =
  | "import-source"
  | "import-tax"
  | "start-allocation"
  | "continue-review"
  | "confirm-commit";

export type NextAction = {
  kind: NextActionKind;
  eyebrow: string;
  title: string;
  description: string;
  label: string;
  batchId?: string;
};

export type NextActionInput = {
  sourceCount: number;
  taxCount: number;
  batches: GuidanceBatch[];
};

export type DraftProgressInput = {
  hasSources: boolean;
  parametersReady: boolean;
  hasSimulation: boolean;
  hasTemplate: boolean;
};

export type DraftProgress = {
  stage: 1 | 2 | 3;
  nextLabel: string;
  canGenerate: boolean;
};

/**
 * Produces one actionable recommendation so the overview never asks the user
 * to choose between several equally prominent buttons.
 */
export function deriveNextAction(input: NextActionInput): NextAction {
  if (input.sourceCount < 1) {
    return {
      kind: "import-source",
      eyebrow: "准备账簿",
      title: "先导入金额来源",
      description: "导入后网站会建立唯一余额账簿；试算本身不会扣减任何金额。",
      label: "导入金额来源",
    };
  }
  if (input.taxCount < 1) {
    return {
      kind: "import-tax",
      eyebrow: "补齐资料",
      title: "上传税务主体资料",
      description: "商品参数和金额已经可以处理；开票明细需要先用税务表完成主体匹配。",
      label: "上传税务资料",
    };
  }

  const pending = input.batches.find((batch) => !batch.isStale);
  if (pending) {
    if (pending.passedReviews >= 2) {
      return {
        kind: "confirm-commit",
        eyebrow: "核验已齐",
        title: `确认“${pending.product}”正式入账`,
        description: "两份独立核验均已通过。入账仍需要你输入独立控制口令，余额才会更新。",
        label: "查看并确认入账",
        batchId: pending.id,
      };
    }
    return {
      kind: "continue-review",
      eyebrow: `核验 ${Math.min(pending.passedReviews, 2)}/2`,
      title: `继续处理“${pending.product}”`,
      description: "批次已冻结，余额尚未扣减。可下载核验资料、查看 AI 预检并接续独立复核。",
      label: "继续核验",
      batchId: pending.id,
    };
  }

  return {
    kind: "start-allocation",
    eyebrow: "账簿已就绪",
    title: "开始下一批商品分摊",
    description: "用一句话输入商品、单价和数量，系统会先做精确试算；试算通过后再生成文件。",
    label: "新建分摊",
  };
}

/** Maps the draft form to the first three steps of the allocation journey. */
export function deriveDraftProgress(input: DraftProgressInput): DraftProgress {
  if (!input.hasSources) {
    return { stage: 1, nextLabel: "先导入金额来源", canGenerate: false };
  }
  if (!input.parametersReady) {
    return { stage: 1, nextLabel: "填写商品参数", canGenerate: false };
  }
  if (!input.hasSimulation) {
    return { stage: 2, nextLabel: "开始精确试算", canGenerate: false };
  }
  return {
    stage: 3,
    nextLabel: input.hasTemplate ? "生成待核验文件" : "选择开票模板",
    canGenerate: input.hasTemplate,
  };
}
