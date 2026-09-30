import { audit, byId, emit, insert, q, update, type Row } from "@dotaka/db";
import { REJECTION_REASONS, judge, recordDecision, rejectionHeuristic, rejectionQuestions } from "@dotaka/jev";
import { AppError, nowIso } from "@dotaka/shared";
import { enqueue } from "./queue.ts";
import { approveTask, setTaskStatus } from "./runtime.ts";
import { applyProposal } from "./learning.ts";
import { scheduleDrafts } from "./creative.ts";
import { sendZaloFollowUp } from "./zalo-followup.ts";

/**
 * Approval gate (spec §5, §14): approve | edit | reject, with a reason.
 * Edits and rejections are learning signals: Jev classifies the CEO's note into a reason
 * category so the Feedback Agent can aggregate them.
 */
export async function decideApproval(bizId: string, approvalId: string, decision: "approve" | "edit" | "reject", note: string | undefined, edited: string | undefined, actor = "ceo") {
  const ap = byId<Row>("approval", approvalId);
  if (!ap || ap.biz_id !== bizId) throw new AppError("NOT_FOUND", "Không tìm thấy mục duyệt", 404);
  if (ap.status !== "pending") throw new AppError("ALREADY_DECIDED", "Mục này đã được xử lý");
  if (ap.expires_at && new Date(ap.expires_at) < new Date()) {
    update("approval", ap.id, { status: "expired" });
    throw new AppError("EXPIRED", "Mục duyệt đã hết hạn");
  }
  const status = decision === "approve" ? "approved" : decision === "edit" ? "edited" : "rejected";
  update("approval", ap.id, { status, decided_by: actor, decision_note: note ?? null, decided_at: nowIso() });
  audit(bizId, actor, `approval.${status}`, { type: ap.subject_type, id: ap.subject_id }, { note, edited: Boolean(edited) });

  if (decision !== "approve" && note) {
    const j = await judge({ bizId, purpose: "feedback.rejection", subject: { type: "approval", id: ap.id }, state: { ceo_note: note, draft_title: ap.title }, questions: rejectionQuestions, heuristic: rejectionHeuristic });
    const reason = (j.answers as any).reason;
    recordDecision(j.id, { reason: reason.choice, label: REJECTION_REASONS[reason.choice as keyof typeof REJECTION_REASONS] });
    insert("exemplar", { biz_id: bizId, agent_key: ap.agent_key ?? "content", kind: decision === "edit" ? "ceo_edit" : "avoid", text: `${ap.title}\nGhi chú CEO: ${note}${edited ? `\nBản sửa: ${edited.slice(0, 800)}` : ""}`, outcome: reason.choice });
  }

  switch (ap.subject_type) {
    case "task": {
      const task = byId<Row>("task", ap.subject_id)!;
      if (decision === "reject") {
        setTaskStatus(task, "rejected", {}, actor);
        q.run("UPDATE content_item SET status = 'rejected' WHERE task_id = ?", task.id);
      } else await approveTask(task, actor, decision === "edit" ? edited : undefined);
      break;
    }
    case "ad_candidate": {
      if (decision === "reject") {
        update("ad_candidate", ap.subject_id, { status: "rejected", decision_note: note ?? null });
        const c = byId<Row>("ad_candidate", ap.subject_id)!;
        update("post", c.post_id, { ad_status: "none" });
      } else {
        if (decision === "edit" && edited && /^\d+$/.test(edited.replace(/[.,\s]/g, ""))) update("ad_candidate", ap.subject_id, { daily_budget: Number(edited.replace(/[.,\s]/g, "")) });
        update("ad_candidate", ap.subject_id, { status: "approved" });
        enqueue("ads", "candidate.publish", { candidateId: ap.subject_id }, { bizId, idempotencyKey: `candpub:${ap.subject_id}` });
      }
      break;
    }
    case "action": {
      if (decision === "reject") update("action", ap.subject_id, { status: "blocked", reason: `CEO từ chối: ${note ?? ""}` });
      else {
        update("action", ap.subject_id, { status: "approved" });
        const a = byId<Row>("action", ap.subject_id)!;
        enqueue("ads", "action.execute", { actionId: a.id }, { bizId, idempotencyKey: `exec:${a.id}`, lockKey: `obj:${a.target_id}` });
      }
      break;
    }
    case "creative_job": {
      const job = byId<Row>("creative_job", ap.subject_id)!;
      if (decision === "reject") update("content_item", job.content_item_id, { status: "rejected" });
      else {
        if (decision === "edit" && edited) {
          const ci = byId<Row>("content_item", job.content_item_id)!;
          update("content_item", ci.id, { body: `${edited}\n\n---\n${String(ci.body).split("\n---\n")[1] ?? ""}` });
        }
        scheduleDrafts(bizId, ap.subject_id, actor);
      }
      break;
    }
    case "follow_up": {
      if (decision === "reject") update("follow_up_plan", ap.subject_id, { status: "stopped" });
      else {
        try {
          await sendZaloFollowUp(bizId, ap.subject_id, decision === "edit" && edited ? edited : String(ap.preview?.text ?? ""), actor);
        } catch (e) {
          // Not sent: keep the approval open unless the customer already replied.
          const replied = (e as any)?.code === "CUSTOMER_REPLIED";
          update("approval", ap.id, { status: replied ? "expired" : "pending", decided_at: null, decided_by: null });
          throw e;
        }
      }
      break;
    }
    case "change_proposal": {
      if (decision === "reject") update("change_proposal", ap.subject_id, { status: "rejected" });
      else applyProposal(bizId, ap.subject_id, actor);
      break;
    }
  }
  emit(bizId, "approval.decided", { approvalId: ap.id, status });
  return { status };
}

export function expireApprovals() {
  const rows = q.all<Row>("SELECT * FROM approval WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?", nowIso());
  for (const ap of rows) {
    update("approval", ap.id, { status: "expired" });
    if (ap.subject_type === "task") {
      const t = byId<Row>("task", ap.subject_id);
      if (t?.status === "awaiting_approval") setTaskStatus(t, "expired");
    }
  }
  return rows.length;
}
