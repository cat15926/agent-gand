import { ExecutionError } from '../execution/errors.ts';

/** A different wording, recipient or ordinary user answer cannot grant access. */
export class CollaborationBoundaryError extends ExecutionError {
  readonly recoveryCode = 'PRIVATE_ROUTE_REQUIRES_SCOPE';
  readonly retryable = false;
  readonly allowedRecovery = ['new_scoped_delivery', 'owner_controlled_release'] as const;
  constructor(message: string) {
    super('policy_rejected', `${message}。当前回合已停止；请由 Owner 在“独立材料协作”中明确分配材料，或通过专用发布卡批准摘要。普通回复不会扩大授权。`);
  }
}
