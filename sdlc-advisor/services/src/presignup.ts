import type { PreSignUpTriggerHandler } from 'aws-lambda';

// Demo environment only: auto-confirm every self-registered user so no email/SMS
// verification is required. Students may register as many accounts as they like.
export const handler: PreSignUpTriggerHandler = async (event) => {
  event.response.autoConfirmUser = true;
  if (event.request.userAttributes?.email) event.response.autoVerifyEmail = true;
  return event;
};
