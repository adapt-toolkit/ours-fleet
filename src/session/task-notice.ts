import type {ConversationEventStore} from './conversation-store.js';
export interface TaskNoticeBinding {sessionGeneration:string;acpSessionId:string;promptId:string}
export interface TaskCreatedNotice {operationId:string;taskId:string;title:string;state:string}
/** Only the trusted Fleet audit completion calls this, never model output. */
export function appendTaskCreated(store:ConversationEventStore,binding:TaskNoticeBinding,notice:TaskCreatedNotice):void {
 let after:string|undefined;
 do {
  const page=store.page({after,limit:1000});
  if(page.events.some(e=>e.kind==='fleet.task_created'&&(e.payload as TaskCreatedNotice).operationId===notice.operationId))return;
  if(!page.hasMore)break;after=page.nextCursor;
 }while(after);
 store.append({kind:'fleet.task_created',source:'fleet_lifecycle',...binding,turnId:binding.promptId,payload:notice});
}
