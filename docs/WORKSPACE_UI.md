# Desktop maker workspace

The workspace has three destinations: Chat, App library, and My app. It replaces
the IDE landing dashboard, Views explorer, editor tabs, split panes, and duplicate
assistant sidebar. The existing warm dark surface and amber accent remain.

- Chat is the default, full-height conversation with a bottom composer. Drafts,
  conversation, feature selections, and app interactions survive destination changes
  within the session. This IDE store does not promise persistence after a reload.
- App library starts with collapsed source applications. Expand an application to
  reveal its building blocks; selecting a feature opens plain-English behavior,
  examples, dependencies, limitations, and fixture evidence alongside the list.
- Available features can be added directly, including required dependencies.
  Already-added features cannot be added twice. Removal requires confirmation;
  dependent features and their sections are removed, while notes and chat remain.
  Changing enabled features clears layout history to prevent restoring sections
  without their required engines. Blocked/review findings remain inspectable.
- My app retains the study canvas. Layout edits have Undo/Redo. Feature links return
  to the library; Edit with assistant returns to Chat.

Assistant edits use the existing builder endpoint. A successful response supplies
the answering model. Local library guidance is labeled Project guide and supplies
an explicit navigation action. Neither automatically leaves Chat. Request failures,
invalid edits, cancellation, and stale responses cannot manufacture successful edits.
Cancellation aborts the fetch and ignores late responses. Backend failures appear
beside the composer and leave the app unchanged.

This is an example workspace backed by bundled fixtures, not a live native-analysis
result. Evidence wording distinguishes fixture reports from checks run this session.
There is no new native engine connection or backend contract migration here.

React Aria supplies buttons, fields, application disclosures, and dialogs. The
desktop shell targets widths of 960px and above; mobile layouts are out of scope.

Validation: `npm run test:unit -w @splice/frontend` and `npm run test:studio`.
Browser coverage uses intercepted model replies and includes keyboard expansion,
confirmation focus, dependency selection, conversation retention, request failures,
cancellation, layout history, and desktop resizing. It does not establish live model
or native pipeline acceptance.
