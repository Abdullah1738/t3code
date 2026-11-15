import type { McpDenyReason } from "@t3tools/contracts";
/**
 * A card's subtasks: its flow as steps (write the PR, review, merge and
 * deploy, tell the reporter, read back). Pure rules; KanbanService applies them.
 */
import * as DateTime from "effect/DateTime";

import {
  kanbanOpenStep,
  kanbanStepSubtasks,
  type KanbanActor,
  type KanbanAskOption,
  type KanbanBoard,
  type KanbanCard,
  type KanbanOwnerAsk,
  type KanbanSubtask,
  type KanbanStandingApproval,
  type KanbanRelease,
} from "@t3tools/contracts";

// Unknown continuations need approval, including nouns and possessives after a resource name.
const resourceReleaseClause =
  /^\s+(?:(?:the|a|an)\s+)?(?:Run\s+Cloud\s+)?(?:sessions?|emulators?|sims?|simulators?|box|boxes|holds?|locks?|slots?|phones?(?:\s+(?:holds?|locks?)(?:\/locks?)?)?|devices?)(?:\s+(?:when\s+done|after\s+the\s+run))?\s*(?:$|[.;!?](?=\s|$))/i;
const resourceMention =
  /\b(?:sessions?|emulators?|sims?|simulators?|box|boxes|devices?|phones?(?:\s+(?:holds?|locks?)(?:\/locks?)?)?|holds?|locks?|slots?)\b/i;

const hasReleaseGate = (text: string): boolean => {
  const resourceSubject = new RegExp(
    String.raw`\b(?:(?:the|both|all|each)\s+)?(?:Run\s+Cloud\s+)?${resourceMention.source}(?:\s+([A-Z]|\d+))?(?:\s+(?:is|are|was|were|got|been|now|both|all)){0,2}\s+$`,
    "i",
  );
  for (const release of text.matchAll(/\brelease(?:s|d)?\b/gi)) {
    const before = text.slice(0, release.index);
    const tail = text.slice(release.index + release[0].length);
    if (resourceReleaseClause.test(tail)) continue;
    if (release[0].toLowerCase() === "released") {
      const subject = resourceSubject.exec(before);
      // Resource names ignore case; single-letter labels must be capitals.
      if (
        subject &&
        (subject[1] === undefined || /^(?:[A-Z]|\d+)$/.test(subject[1])) &&
        /^(?:\s+(?:when\s+done|after\s+the\s+run))?\s*(?:$|[.;,!?)](?=\s|$))/i.test(tail)
      )
        continue;
    }
    const reference = /^\s+(?:both|them|each|all|it)\b/i.exec(tail);
    if (reference && resourceMention.test(before)) {
      const rest = tail.slice(reference[0].length);
      if (
        resourceReleaseClause.test(rest) ||
        /^(?:\s+when\s+done)?\s*(?:$|[.;!?](?=\s|$))/i.test(rest)
      )
        continue;
    }
    return true;
  }
  return false;
};

const deployKeyword = /\b(?:deploy\w*|install\w*|restart\w*|launchagents?|release(?:s|d)?)\b/i;
const moneyKeyword =
  /(?:\b(?:pay(?:ment|ments)?|purchase\w*|charg(?:e|es|ed|ing)|refund\w*|money transfer|spend(?:ing)?|billed|billing)\b|[$€£]\s*\d+(?:[.,]\d+)*|\b(?:\d+(?:[.,]\d+)*\s*(?:USD|AED|EUR|GBP|dirhams?|dollars?)\b|(?:USD|AED|EUR|GBP|dirhams?|dollars?)\s*\d+(?:[.,]\d+)*))/i;
const negatableMoneyKeyword = new RegExp(`${moneyKeyword.source}|\\b(?:paying|purchasing)\\b`, "i");
const secretAction =
  /\b(?:share|provide|enter|paste|set|store|create|generate|issue|rotate|regenerate|revoke|reveal|send|give|hand\s+over|add)\b/i;
const negatableSecretAction = new RegExp(
  `${secretAction.source}|\\b(?:sharing|providing|entering|pasting|setting|storing|creating|generating|issuing|rotating|regenerating|revoking|revealing|sending|giving|handing\\s+over|adding)\\b`,
  "i",
);
const secretKeyword =
  /(?<![\w-])(?:secrets?|passwords?|credentials?|tokens?|(?:(?:api|private|signing|ssh)\s+)?keys?)(?![\w-])/i;
const secretNoun = String.raw`(?<![\w-])(?:secrets?|passwords?|credentials?|tokens?|keys?)(?![\w-])`;
const negatableSecretKeyword = new RegExp(String.raw`${secretNoun}(?:[ \t]+${secretNoun})*`, "i");
const secretMention = new RegExp(
  `${secretAction.source}[^.;\\r\\n]{0,40}${secretKeyword.source}`,
  "i",
);

const inlinePairs = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["—", "—"],
  ["–", "–"],
  ["--", "--"],
]);

const inlineClosers = new Set(inlinePairs.values());

function* inlineDelimiters(text: string) {
  for (let i = 0; i < text.length; i++) {
    const index = i;
    let char = text[i]!;
    if (
      (char === "'" || char === "’") &&
      /\w/.test(text[i - 1] ?? "") &&
      /^(?:s|t|re|ve|ll|d|m)\b/i.test(text.slice(i + 1))
    )
      continue;
    if (char === "-" && text[i + 1] === "-") {
      char = "--";
      i++;
    }
    if (inlinePairs.has(char) || inlineClosers.has(char)) yield { char, index };
  }
}

const closesInlineAside = (prefix: string, suffix: string): boolean | undefined => {
  const expected: string[] = [];
  for (const { char, index } of inlineDelimiters(prefix)) {
    if (expected.at(-1) === char) expected.pop();
    else {
      const closing = inlinePairs.get(char);
      const dash = char === "—" || char === "–" || char === "--";
      if (closing && (!dash || prefix.includes(char, index + char.length) || suffix.includes(char)))
        expected.push(closing);
    }
  }
  const depth = expected.length;
  if (depth === 0) return undefined;
  for (const { char, index } of inlineDelimiters(suffix)) {
    if (expected.at(-1) === char) {
      expected.pop();
      if (expected.length < depth) return !negatableSecretKeyword.test(suffix.slice(0, index));
    } else {
      const closing = inlinePairs.get(char);
      const dash = char === "—" || char === "–" || char === "--";
      if (closing && (!dash || suffix.includes(char, index + char.length))) expected.push(closing);
    }
  }
  return false;
};

const withoutNegated = (
  text: string,
  keyword: RegExp,
  options: { readonly boundary?: boolean; readonly object?: RegExp } = {},
): string => {
  const gap = String.raw`(?:[ \t]+|-(?!-))`;
  // Unknown words stay gated: arbitrary fillers can turn "don't delay deployment" into permission.
  const qualifierWord = String.raw`(?:a|an|the|any|my|your|our|their|his|her|its|\w+[’']s|\w+s[’']|new|old|existing|further|additional|more|actual|real|live|prod|production|dev|test|local|remote|planned|scheduled|required|manual|automatic|immediate|full|api|private|signing|ssh)`;
  const filler = String.raw`${qualifierWord}${gap}`;
  const qualifiers = String.raw`(?:(?:just|quite)${gap}yet${gap}|yet${gap}(?:${filler})?|(?:${filler}){0,2}?)`;
  const negation = String.raw`(?:no|not|without|never|don[’']?t|do[ \t]+not|doesn[’']?t|won[’']?t|nothing[ \t]+to)`;
  const objectStop = String.raw`(?:${negatableSecretAction.source}|${negation}|and|or|but|then|yet|so|however|instead|except)\b`;
  const objectQualifier = String.raw`(?!${objectStop})\w+(?:[’']s)?${gap}`;
  const pluralPossessive = String.raw`(?!(?:${negatableSecretKeyword.source})[’'])\w+s[’'](?=${gap}(?:${objectQualifier})*${secretKeyword.source}[^.;\r\n]*[)\]}"'”’–—])`;
  const objectWord = String.raw`(?:\w+[’']s|${pluralPossessive}|\w+)`;
  const objectFiller = String.raw`(?!${objectStop})${objectWord}${gap}`;
  // Consume the whole noun phrase: stopping at "secret" strands "token" inside an aside.
  const objectQualifiers = options.boundary ? String.raw`(?:${objectFiller})*` : qualifiers;
  const bareObject = options.object ? `${objectQualifiers}${options.object.source}` : "";
  const quotedObjects = (
    [
      ["'", "'"],
      ['"', '"'],
      ["‘", "’"],
      ["“", "”"],
    ] as const
  ).map(([open, close]) => String.raw`${objectQualifiers}${open}[ \t]*${bareObject}[ \t]*${close}`);
  const objectItem = options.object ? `(?:${[bareObject, ...quotedObjects].join("|")})` : "";
  const objectSeparator = String.raw`(?:[ \t]*,[ \t]*(?:(?:and|or)[ \t]+)?|[ \t]+(?:and|or)[ \t]+)`;
  const objectList = options.boundary ? String.raw`(?:${objectSeparator}${objectItem})*` : "";
  const object = options.object ? String.raw`(?:${gap}${objectItem}${objectList})?` : "";
  const precedingNegation = new RegExp(String.raw`\b${negation}${gap}$`, "i");
  const sharedObject = new RegExp(
    String.raw`${secretAction.source}(?:[ \t,:()\[\]{}"'“”‘’–—-]|\b(?:${qualifierWord}|and|but|or|then|also)\b)*$`,
    "i",
  );
  const boundaries: number[] = [];
  let delta = 0;
  const stripped = text.replace(
    new RegExp(
      String.raw`\b(?:${negation}${gap}${qualifiers}|non${gap})(${keyword.source})(${object})`,
      "gi",
    ),
    (match, action: string, directObject: string, offset: number) => {
      const prefix = text.slice(0, offset);
      let before = prefix;
      let negations = 0;
      for (
        let previous = precedingNegation.exec(before);
        previous;
        previous = precedingNegation.exec(before)
      ) {
        negations++;
        before = before.slice(0, previous.index);
      }
      if (negations % 2 === 1) return match;
      if (/^keys?$/i.test(action) && /^(?:no|not)-(?:api|private|signing|ssh)[ \t-]/i.test(match))
        return action;
      const modifier = /^(?:(?:no|not)-|non\b)/i.test(match);
      const aside = options.boundary
        ? closesInlineAside(prefix, text.slice(offset + match.length))
        : undefined;
      const shared = options.boundary ? (aside ?? sharedObject.test(prefix)) : false;
      const replacement = options.boundary && !modifier && !shared ? ";" : " ";
      // "No-restart deployment" negates the modifier, unlike "don't restart the deployment".
      const nounModifier =
        !options.boundary &&
        /^no[ \t]/i.test(match) &&
        !/ing$/i.test(action) &&
        /\b(?:a|an|the)[ \t]+$/i.test(prefix);
      const value =
        modifier || nounModifier || (options.boundary && shared && aside === undefined)
          ? replacement + directObject
          : replacement;
      if (options.boundary && value.startsWith(";")) boundaries.push(offset + delta);
      delta += value.length - match.length;
      return value;
    },
  );
  if (boundaries.length === 0) return stripped;
  // Resolve an aside after all its negated actions have lost their objects.
  const characters = stripped.split("");
  for (const position of boundaries) {
    if (closesInlineAside(stripped.slice(0, position), stripped.slice(position + 1)) === true)
      characters[position] = " ";
  }
  return characters.join("");
};

export const inferGate = (text: string): KanbanSubtask["gate"] => {
  const deployText = withoutNegated(text, deployKeyword, { object: deployKeyword });
  if (
    /\b(deploy\w*|install\w*|restart\w*|launchagents?)\b/i.test(deployText) ||
    hasReleaseGate(deployText)
  )
    return "deploy";
  if (moneyKeyword.test(withoutNegated(text, negatableMoneyKeyword, { object: moneyKeyword })))
    return "money";
  // Removing a negated action must not attach its object to an earlier unrelated action.
  const secretText = withoutNegated(
    withoutNegated(text, negatableSecretAction, { boundary: true, object: secretKeyword }),
    negatableSecretKeyword,
  );
  if (secretMention.test(secretText)) return "secret";
  return undefined;
};

export const gateOf = (
  subtask: Pick<
    KanbanSubtask,
    "owner" | "gate" | "text" | "gateCleared" | "ownerOnly" | "interrupting"
  >,
  guessedGates?: KanbanBoard["guessedGates"],
): KanbanSubtask["gate"] => {
  if (subtask.gateCleared !== undefined) return undefined;
  // Older plans stored inferred gates on coding and review checklists too.
  if (subtask.owner === "work" || subtask.owner === "review") return undefined;
  if (subtask.gate !== undefined) return subtask.gate;
  if (subtask.ownerOnly) return "deploy";
  const guessed = inferGate(subtask.text);
  return guessed !== undefined && (guessedGates === undefined || guessedGates.includes(guessed))
    ? guessed
    : subtask.interrupting
      ? "deploy"
      : undefined;
};

export const isNegativeOption = (label: string): boolean =>
  /(?:^(?:no\b|not\b|don[’']?t\b|do\s+not\b|reject\b|drop\b|skip\b|leave\b|hold\b|cancel\b|wait\b|stop\b)|\b(?:later|tomorrow|not yet|next week|next month)\b)/i.test(
    label.trim(),
  );

const approvalAction = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\b(?:the|a|an)\b/g, "")
    .trim()
    .replace(/[.!]+$/, "")
    .trim()
    .replace(/^deployment\b/, "deploy")
    .replace(/^installation\b/, "install")
    .replace(/^payment\b/, "pay")
    .replace(/^buy\b/, "purchase")
    .replace(/^sharing\b/, "share")
    .replace(/\s+/g, " ");

const harmlessFollowup = (task: string, target: string): boolean => {
  const text = task
    .trim()
    .replace(/[.!]+$/, "")
    .trim();
  const suffix =
    /(?:\s+(?:(?:and(?:\s+then)?|then)\s+)?|\s*,\s*(?:then\s+)?)(?:read back|read-back|verify|check|confirm|test|report back)(?:\s+(?:its version|it|the result))?$/i.exec(
      text,
    );
  if (!suffix) return false;
  const action = text.slice(0, suffix.index).trimEnd();
  // Keep the suffix raw: removing articles could turn an extra object ("the test") into a verb.
  return !/(?:[.!]|\b(?:a|an|the))$/i.test(action) && approvalAction(action) === target;
};

export const approvesGate = (
  label: string,
  gate: NonNullable<KanbanSubtask["gate"]>,
  task: string,
  others: readonly string[],
  scope: "subtask" | "standing" = "standing",
): boolean => {
  const words = label
    .trim()
    .replace(/[.!]+$/, "")
    .trim();
  if (
    isNegativeOption(words) ||
    /\b(?:if|unless|after|before|once|when|pending|first|then)\b/i.test(words)
  )
    return false;
  const command = words
    .replace(/^(?:yes|ok|okay)(?:\s*[,.:;–—-]\s*|\s+)/i, "")
    .replace(/^(?:(?:please|go ahead and)\s+)+/i, "");
  if (
    /^(?:yes|approve|approved|sign off|sign-off|signoff|signed off|go|go ahead|go for it|ok|okay|do it|proceed)$/i.test(
      command,
    )
  )
    return true;
  // Retaining one merge cannot grant permission for future deployments.
  if (
    scope === "subtask" &&
    gate === "deploy" &&
    /^merge\b/i.test(task.trim()) &&
    /^keep it$/i.test(command) &&
    others.some((other) => /^revert it[.!]*$/i.test(other.trim()))
  )
    return true;
  const action = command.replace(/^(?:approve|approved|authorize)\s+/i, "");
  const normalized = approvalAction(action);
  const target = normalized.replace(/\s+now$/, "");
  const taskAction = approvalAction(task);
  if (target === taskAction.replace(/\s+now$/, "")) return true;
  let verb: RegExp;
  switch (gate) {
    case "deploy":
      verb = /^(?:deploy|install|restart|release)\b/i;
      break;
    case "money":
      verb = /^(?:pay|purchase|buy|charge|refund|transfer)\b/i;
      break;
    case "secret":
      verb = /^(?:share|provide|use|enter|set|rotate|reveal|send|show)\b/i;
      break;
  }
  const operation = action !== command ? normalized : action;
  const matched = verb.exec(operation)?.[0];
  if (matched) {
    const suffix = taskAction.startsWith(target) ? taskAction.slice(target.length) : null;
    if (suffix !== null && action === command && normalized === target) {
      if (harmlessFollowup(task, target)) return true;
    } else if (
      /^(?:\s+(?:it|this|that|these|those))?(?:\s+now)?$/i.test(operation.slice(matched.length)) ||
      (suffix !== null && harmlessFollowup(task, target))
    ) {
      return true;
    }
  }
  if (gate === "secret") return false;
  const choiceVerb =
    gate === "deploy"
      ? /\b(?:deploy\w*|release|install|restart|ship)\b/i
      : /\b(?:pay|purchase|buy|charge|refund|transfer)\b/i;
  return (
    choiceVerb.test(command) &&
    !/\b(?:not|no|[a-z]+n[’']t|dont|never|cannot|without|except|only|instead|partial|dry[- ]?run|draft|plan|preview|prepare)\b/i.test(
      command,
    ) &&
    others.some((other) => isNegativeOption(other) || !choiceVerb.test(other))
  );
};

const optionScopeIds = (
  card: Pick<KanbanCard, "subtasks">,
  option: Pick<KanbanAskOption, "label" | "approves">,
): ReadonlyArray<string> | undefined => {
  if (option.approves !== undefined) return option.approves;
  if (!/^(?:yes|ok|approve|approved|go\s+ahead)\b/i.test(option.label.trim())) return undefined;
  const ids = option.label.match(/\bs\d+\b/g);
  if (!ids) return undefined;
  return ids.filter((id) => card.subtasks.some((subtask) => subtask.id === id));
};

const refusalWord = /\b(?:decline|refuse|deny|defer|postpone|delay|pause|suspend|abort)\b/i;

export const optionApprovalIds = (
  card: Pick<KanbanCard, "subtasks">,
  option: Pick<KanbanAskOption, "label" | "approves">,
): ReadonlyArray<string> | undefined => {
  if (
    isNegativeOption(option.label) ||
    /\b(?:if|unless|after|before|once|when|pending|first|then|not|no|[a-z]+n[’']t|dont|never|cannot|without|except|only|instead)\b/i.test(
      option.label,
    )
  )
    return undefined;
  if (option.approves !== undefined) {
    if (!isNegativeChoice(option.label)) return option.approves;
    // Exact action targets can contain refusal words, such as an "on-hold build".
    return option.approves.length > 0 &&
      option.approves.every((id) => {
        const subtask = card.subtasks.find((candidate) => candidate.id === id);
        const gate = subtask && gateOf(subtask);
        return subtask && gate && approvesGate(option.label, gate, subtask.text, [], "subtask");
      })
      ? option.approves
      : undefined;
  }
  // Label shorthand accepts a direct id list, never additional clauses or qualifications.
  if (
    !/^(?:yes|ok|approve|approved|go\s+ahead)\b[\s,.:;–—-]+(?:(?:tick|clear|do|approve)\s+)?s\d+(?:(?:\s*[,;/&+]\s*(?:and\s+)?|\s+(?:and\s+)?)s\d+)*(?:\s+now)?[.!]*$/i.test(
      option.label.trim(),
    )
  )
    return undefined;
  return optionScopeIds(card, option);
};

const isNegativeChoice = (label: string): boolean => {
  if (refusalWord.test(label)) return true;
  // Polite prefixes and object-first phrasing must not hide a refusal from the broad fallback.
  for (const word of label.matchAll(/\b\w/g)) {
    if (isNegativeOption(label.slice(word.index))) return true;
  }
  return false;
};

const askWording = (ask: KanbanOwnerAsk) =>
  `${ask.text} ${ask.title ?? ""} ${ask.action?.summary ?? ""}`;

const askConcerns = (
  card: Pick<KanbanCard, "createdAt" | "subtasks">,
  ask: KanbanOwnerAsk,
  subtask: KanbanSubtask,
  gate: NonNullable<KanbanSubtask["gate"]>,
  guessedGates: KanbanBoard["guessedGates"],
  answerAt: string,
): boolean => {
  const wording = askWording(ask);
  const ids = new Set(wording.match(/\bs\d+\b/g) ?? []);
  if (ids.size > 0) return ids.has(subtask.id);
  if (subtask.ownerOnly) return false;
  const candidates = card.subtasks.filter(
    (entry) =>
      gateOf(entry, guessedGates) === gate &&
      (entry.state !== "skipped" || entry.id === subtask.id) &&
      (entry.createdAt ?? card.createdAt) <= answerAt,
  );
  return inferGate(wording) === gate && candidates.length === 1 && candidates[0]?.id === subtask.id;
};

export const askGateWarning = (
  card: Pick<KanbanCard, "createdAt" | "subtasks">,
  ask: KanbanOwnerAsk,
  guessedGates?: KanbanBoard["guessedGates"],
): string | undefined => {
  const gated = card.subtasks.flatMap((subtask) => {
    const gate = gateOf(subtask, guessedGates);
    return subtask.state === "open" && gate !== undefined ? [{ subtask, gate }] : [];
  });
  const scoped = ask.options?.some((option) => optionScopeIds(card, option) !== undefined);
  if (
    gated.length === 0 ||
    gated.some(({ subtask, gate }) =>
      scoped
        ? ask.options?.some((option) => optionApprovalIds(card, option)?.includes(subtask.id))
        : askConcerns(card, ask, subtask, gate, guessedGates, ask.at),
    )
  )
    return undefined;
  const steps = gated.map(({ subtask, gate }) => `${subtask.id} (${gate})`).join(", ");
  const target = gated.length === 1 ? gated[0]!.subtask.id : "the intended subtask id";
  return `This ask won't clear ${steps}. Name ${target} in the text if it should.`;
};

export const secretKindApprovalWarning = (
  card: Pick<KanbanCard, "subtasks">,
  ask: KanbanOwnerAsk,
  guessedGates?: KanbanBoard["guessedGates"],
): string | undefined => {
  if (ask.kind !== "secret") return undefined;
  const ids = card.subtasks
    .filter((subtask) => subtask.state === "open" && gateOf(subtask, guessedGates) === "secret")
    .map((subtask) => subtask.id);
  if (ids.length === 0) return undefined;
  const target = ids.length === 1 ? ids[0]! : "the intended subtask id";
  return `Kind "secret" asks Abdullah to type a secret value. To approve ${ids.join(", ")}, ask a decision naming ${target} instead.`;
};

const approvingAnswer = (
  card: Pick<KanbanCard, "subtasks">,
  ask: KanbanOwnerAsk,
  gate: NonNullable<KanbanSubtask["gate"]>,
  subtask: KanbanSubtask,
): boolean => {
  const answer = ask.answer;
  // Multiple picks keep the strict paths; the go/hold fallback needs a single choice.
  const others =
    answer?.optionIds?.length === 1
      ? (ask.options ?? [])
          .filter((option) => !answer.optionIds!.includes(option.id))
          .map((option) => option.label)
      : [];
  const scoped = ask.options?.some((option) => optionScopeIds(card, option) !== undefined);
  const explicitlyApproved =
    (answer?.verdict === "picked" || answer?.verdict === "approved") &&
    answer.optionIds?.length === 1 &&
    ask.options?.some(
      (option) =>
        option.id === answer.optionIds?.[0] &&
        optionApprovalIds(card, option)?.includes(subtask.id),
    );
  const approved = scoped
    ? explicitlyApproved
    : (answer?.verdict === "approved" && !answer.optionIds?.length) ||
      ((answer?.verdict === "picked" || answer?.verdict === "approved") &&
        Boolean(answer.optionIds?.length) &&
        answer.optionIds!.every((id) => {
          const option = ask.options?.find((entry) => entry.id === id);
          return (
            option !== undefined &&
            (approvesGate(option.label, gate, subtask.text, [], "subtask") ||
              (!isNegativeChoice(option.label) &&
                approvesGate(option.label, gate, subtask.text, others, "subtask")))
          );
        }));
  return Boolean(approved);
};

export interface StandingReleaseContext {
  readonly approvals: ReadonlyArray<KanbanStandingApproval>;
  readonly ledger: ReadonlyArray<KanbanRelease>;
  readonly boardId: string;
  readonly at: string;
  readonly note: string | null;
}

export const criticalReleaseReason = (note: string | null): string | null => {
  if (!note?.startsWith("critical:")) return null;
  const reason = note.slice("critical:".length).trim();
  return reason.length >= 10 ? reason : null;
};

export const releaseWindow = (
  standing: Pick<StandingReleaseContext, "approvals" | "ledger" | "boardId" | "at">,
) => {
  const approval = standing.approvals.find((entry) => entry.revokedAt === null);
  const last = standing.ledger
    .filter((entry) => entry.boardId === standing.boardId)
    .toSorted((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  if (!approval || !last) return null;
  const hours = approval.minIntervalHours ?? 4;
  const next = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(last.at), { hours }));
  return next > standing.at ? { last, next, hours } : null;
};

/** Legacy plans have no timestamps: their card's creation is the earliest safe bound. */
export const approvalProblem = (
  card: Pick<KanbanCard, "number" | "asks" | "createdAt" | "subtasks">,
  subtask: KanbanSubtask,
  standing: ReadonlyArray<KanbanStandingApproval> | StandingReleaseContext = [],
  guessedGates?: KanbanBoard["guessedGates"],
  intent: "do" | "skip" = "do",
): string | null => {
  if (subtask.state === "skipped" && subtask.gateSkipped !== undefined) return null;
  const gate = gateOf(subtask, guessedGates);
  if (gate === undefined) return null;
  const context = "approvals" in standing ? standing : undefined;
  const approvals = "approvals" in standing ? standing.approvals : standing;
  const cleared =
    gate === "deploy" && !subtask.ownerOnly && approvals.some((entry) => entry.revokedAt === null);
  const window =
    cleared && subtask.interrupting && context && intent === "do" ? releaseWindow(context) : null;
  if (cleared && (!window || criticalReleaseReason(context?.note ?? null))) return null;
  const standingReason =
    gate !== "deploy"
      ? ""
      : subtask.ownerOnly
        ? " (marked owner-only)"
        : " (this board has no standing deploy approval)";
  const since = subtask.createdAt ?? card.createdAt;
  const decisions = card.asks
    .filter((ask) => {
      if (ask.kind === "notice" || ask.respond?.ack) return false;
      const answer = ask.answer;
      if (!ask.closedAt || !answer || answer.at < since) return false;
      if (answer.verdict !== "dropped") {
        // Closing clears handedAt; direct-to-evaluator asks retain their `to` instead.
        const handedSkip =
          intent === "skip" &&
          answer.verdict === "handed" &&
          answer.by._tag === "evaluator" &&
          ask.to !== "evaluator";
        if ((answer.by._tag !== "owner" && !handedSkip) || (ask.revisedAt ?? ask.at) < since)
          return false;
        if (ask.draft) return false;
        if (handedSkip) {
          const wording = `${askWording(ask)} ${answer.text ?? ""} ${answer.note ?? ""}`;
          return new Set(wording.match(/\bs\d+\b/g) ?? []).has(subtask.id);
        }
      }
      // Explicit scopes replace wording matching for the entire ask, including other options.
      if (ask.options?.some((option) => optionScopeIds(card, option) !== undefined)) {
        const selected =
          (answer.verdict === "picked" || answer.verdict === "approved") &&
          answer.optionIds?.length === 1
            ? ask.options.find((option) => option.id === answer.optionIds?.[0])
            : undefined;
        const selectedIds = selected ? optionApprovalIds(card, selected) : undefined;
        // A refusal concerns the whole ask; a scoped go choice concerns only its own ids.
        return selectedIds !== undefined
          ? selectedIds.includes(subtask.id)
          : ask.options.some((option) => optionScopeIds(card, option)?.includes(subtask.id));
      }
      return askConcerns(card, ask, subtask, gate, guessedGates, answer.at);
    })
    .toSorted((a, b) => a.answer!.at.localeCompare(b.answer!.at));
  const latest = decisions.at(-1);
  const answer = latest?.answer;
  const unnamedApproval = card.asks
    .filter(
      (ask) =>
        ask.kind !== "notice" &&
        !ask.respond?.ack &&
        ask.closedAt &&
        ask.answer !== undefined &&
        approvingAnswer(card, ask, gate, subtask) &&
        ask.answer.by._tag === "owner" &&
        ask.answer.at >= since &&
        (answer === undefined || ask.answer.at > answer.at) &&
        (ask.revisedAt ?? ask.at) >= since &&
        !ask.draft &&
        !/\bs\d+\b/.test(askWording(ask)) &&
        !askConcerns(card, ask, subtask, gate, guessedGates, ask.answer.at),
    )
    .toSorted((a, b) => a.answer!.at.localeCompare(b.answer!.at))
    .at(-1);
  const clearGuidance =
    subtask.gateSource === "set" || subtask.ownerOnly || subtask.interrupting
      ? `; this gate was set on purpose and still needs Abdullah's answer naming ${subtask.id}`
      : `; for a guessed gate on an evaluator/script step, an evaluator can pass clearGate with a reason on ${subtask.id}; a gate set on purpose still needs Abdullah's answer naming ${subtask.id}`;
  const noDecisionReason = unnamedApproval
    ? `${unnamedApproval.id} was approved but doesn't name ${subtask.id}; ask again naming the subtask id (e.g. "Approve ${subtask.id}")`
    : `no owner answer on a ${gate} ask since ${since}; ask with card_ask naming ${subtask.id} (e.g. "Approve ${subtask.id}: <step>")`;
  if (intent === "skip") {
    if (
      answer &&
      answer.verdict !== "dropped" &&
      (answer.by._tag === "owner" || answer.verdict === "handed")
    )
      return null;
    const reason =
      answer?.verdict === "dropped"
        ? `the latest decision, ${latest!.id}, was dropped (a dropped ask is not approval)`
        : `${noDecisionReason}; no owner answer on a ${gate} ask since ${since}; name the subtask id (e.g. s7) in the ask or set approves: [${subtask.id}] on the go option`;
    const handedGuidance =
      answer?.verdict !== "dropped" && card.asks.some((ask) => ask.answer?.verdict === "handed")
        ? "; a handed answer must name the subtask id and come from an ask the owner handed to the evaluator"
        : "";
    return `card #${card.number} subtask ${subtask.id} (${gate}: ${subtask.text}) needs Abdullah's answer before it can be skipped: ${reason}${standingReason}${clearGuidance}${handedGuidance}`.replace(
      /[\r\n]+/g,
      " ",
    );
  }
  const scoped = latest?.options?.some((option) => optionScopeIds(card, option) !== undefined);
  const approved = latest !== undefined && approvingAnswer(card, latest, gate, subtask);
  if (
    approved &&
    (!window || (askWording(latest!).match(/\bs\d+\b/g) ?? []).some((id) => id === subtask.id))
  )
    return null;
  if (window) {
    const time = (at: string) => `${at.slice(11, 16)}Z`;
    return `card #${card.number} ${subtask.id} (interrupting) is inside the ${window.hours} h release window: last release #${window.last.cardNumber} at ${time(window.last.at)}, next window ${time(window.next)}; write "critical: <reason>" in the done note to override`;
  }
  let reason: string;
  if (!latest || !answer) {
    reason = `${noDecisionReason}; no owner answer on a ${gate} ask since ${since}; name the subtask id (e.g. s7) in the ask or set approves: [${subtask.id}] on the go option`;
  } else if (answer.verdict === "dropped") {
    reason = `the latest decision, ${latest.id}, was dropped (a dropped ask is not approval)`;
  } else if (answer.verdict === "picked") {
    const labels = (answer.optionIds ?? [])
      .map((id) => latest.options?.find((option) => option.id === id)?.label ?? id)
      .join(", ");
    reason = `the latest decision, ${latest.id}, picked "${labels}", which doesn't read as approving ${gate}; ask again with an Approve option or an action ask`;
  } else if (scoped && answer.verdict === "approved") {
    reason = `the latest decision, ${latest.id}, approved without one scoped go option; pick exactly one option naming ${subtask.id} or carrying approves: [${subtask.id}]`;
  } else {
    reason = `the latest decision, ${latest.id}, was ${answer.verdict}`;
  }
  if (latest && unnamedApproval) {
    reason += `; ${unnamedApproval.id} (approved later) doesn't name ${subtask.id}, so it doesn't count; ask again naming ${subtask.id} (e.g. "Approve ${subtask.id}: <step>")`;
  }
  return `card #${card.number} subtask ${subtask.id} (${gate}: ${subtask.text}) needs Abdullah's approval: ${reason}${standingReason}${clearGuidance}`.replace(
    /[\r\n]+/g,
    " ",
  );
};

export const MAX_SUBTASKS = 30;
export const MAX_TEXT = 500;

// Only complete generic instructions have unambiguous sentence punctuation; arguments stay literal.
const approvalProse =
  /^(?:(?:deploy|install) the (?:build|release)|restart the (?:helper|service|server)|pay the invoice|rotate the API key)[.!;:]*$/;

const approvalText = (text: string) => {
  const normalized = text.trim().replace(/\s+/g, " ");
  const prose = normalized.replace(/^\w+/, (verb) => verb.toLowerCase());
  return approvalProse.test(prose) ? prose.replace(/[.!;:]+$/, "") : normalized;
};

export interface SubtaskInput {
  /** An existing id alone keeps the subtask unchanged; leave out for a new one. */
  readonly id?: string | undefined;
  /** Same step means any order; defaults to the stored step, or the next step for a new entry. */
  readonly step?: number | undefined;
  readonly text?: string | undefined;
  readonly owner?: KanbanSubtask["owner"] | undefined;
  readonly gate?: KanbanSubtask["gate"] | null;
  readonly clearGate?: string | undefined;
  readonly ownerOnly?: boolean | undefined;
  readonly interrupting?: boolean | undefined;
  /** For a script's subtask: the name of the board script that does it. Absent: any script on the card's board. */
  readonly script?: string | undefined;
}

/**
 * What an evaluator does first on a card a thread or a script made: the prompt
 * it came with is a note, and the work thread (maybe the cheapest model) only
 * gets the prompt.
 */
export const PACKET_SUBTASK =
  "Write the packet: read what the card points at (sessions, PRs, the code, the architecture) and rewrite its prompt with card_edit so the cheapest model can do it: scope, files, steps, tests, and when it's done. Add the rest of the plan.";

/** Puts the packet first; every step the inputs set moves one later. */
export const withPacketStep = (
  inputs: ReadonlyArray<SubtaskInput>,
): ReadonlyArray<SubtaskInput> => [
  { step: 1, text: PACKET_SUBTASK, owner: "evaluator" },
  ...inputs.map((input) => (input.step === undefined ? input : { ...input, step: input.step + 1 })),
];

export type SubtaskPlan =
  | {
      readonly ok: true;
      readonly subtasks: ReadonlyArray<KanbanSubtask>;
      /** The card's counter after this plan; store it with the card. */
      readonly subtaskSeq: number;
    }
  | { readonly ok: false; readonly reason: string; readonly code?: "denied" };

/**
 * Who is marking a subtask. Evaluators can mark any; a worker only its own
 * kind. A reviewer marks none: its verdict ticks the review's subtasks.
 */
export type SubtaskRole = "work" | "review" | "evaluator" | "script";

export type MarkCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly denyReason: McpDenyReason };

const idNumber = (id: string) => Number.parseInt(id.replace(/^s/, ""), 10) || 0;

/**
 * Replaces a card's plan with `inputs`. An id alone keeps that subtask;
 * omitted text, owner and step on open ids keep their stored values. New
 * entries need text and owner and get the next id. Listed done and skipped
 * subtasks stay unchanged, and omitted ones stay: what happened isn't rewritten.
 * `seq` is the card's counter of ids ever handed out, so an open subtask dropped
 * from the plan never has its id reused by a later entry.
 */
export function planSubtasks(
  existing: ReadonlyArray<KanbanSubtask>,
  inputs: ReadonlyArray<SubtaskInput>,
  seq = 0,
  at?: string,
  guessedGates?: KanbanBoard["guessedGates"],
  actor?: KanbanActor,
): SubtaskPlan {
  const planGate = (
    input: SubtaskInput,
    owner: KanbanSubtask["owner"],
    text: string,
    ownerOnly: boolean | undefined,
    interrupting: boolean | undefined,
    known?: KanbanSubtask,
  ) => {
    const previousGate = known && gateOf(known, guessedGates);
    const keepClear =
      known?.gateCleared !== undefined &&
      text === known.text &&
      input.gate == null &&
      input.ownerOnly !== true &&
      input.interrupting !== true;
    const inputGate = gateOf(
      { owner, text, gate: input.gate ?? undefined, ownerOnly, interrupting },
      guessedGates,
    );
    const gate =
      owner === "work" || owner === "review" || keepClear
        ? undefined
        : previousGate === "deploy" &&
            (known?.interrupting || interrupting) &&
            (inputGate === "money" || inputGate === "secret")
          ? inputGate
          : (previousGate ?? inputGate);
    const gateSource =
      gate === undefined
        ? undefined
        : input.gate != null || ownerOnly || interrupting
          ? ("set" as const)
          : previousGate
            ? (known?.gateSource ?? ("guessed" as const))
            : ("guessed" as const);
    return { gate, gateSource, previousGate, keepClear };
  };
  const byId = new Map(existing.map((subtask) => [subtask.id, subtask]));
  // Cards saved before the counter existed start from the highest id still on them.
  let nextId = existing.reduce((max, subtask) => Math.max(max, idNumber(subtask.id)), seq);
  const listed = new Set<string>();
  const planned: Array<KanbanSubtask> = [];
  let step = 0;
  for (const input of inputs) {
    const id = input.id?.trim();
    const reason = input.clearGate?.trim();
    if (reason !== undefined) {
      if (!id) return { ok: false, reason: "clearGate needs an existing subtask id" };
      if (input.gate != null)
        return { ok: false, reason: "clearGate cannot be combined with an explicit gate" };
      if (reason.length < 10 || reason.length > 300)
        return { ok: false, reason: "clearGate needs a reason of 10–300 characters" };
    }
    const known = id ? byId.get(id) : undefined;
    if (id) {
      if (!known)
        return {
          ok: false,
          reason: `the card has no subtask ${id}. Existing subtask ids: ${subtaskIds(existing) || "none"}`,
        };
      if (listed.has(id)) return { ok: false, reason: `subtask ${id} is listed twice` };
      listed.add(id);
      // An id alone also preserves script bindings and approval timestamps.
      if (
        known.state !== "open" ||
        (input.text === undefined &&
          input.owner === undefined &&
          input.step === undefined &&
          input.gate === undefined &&
          input.clearGate === undefined &&
          input.ownerOnly === undefined &&
          input.interrupting === undefined &&
          input.script === undefined)
      ) {
        planned.push(known);
        step = known.step;
        continue;
      }
    }
    const rawText = input.text ?? known?.text;
    const owner = input.owner ?? known?.owner;
    if (rawText === undefined || owner === undefined) {
      return { ok: false, reason: "a new subtask needs text and owner" };
    }
    const text = rawText.trim();
    if (text.length === 0) return { ok: false, reason: "a subtask needs text" };
    if (text.length > MAX_TEXT) {
      return { ok: false, reason: `a subtask is at most ${MAX_TEXT} characters` };
    }
    if (owner === "work" && input.gate != null) {
      return {
        ok: false,
        reason: `subtask "${text}" is the worker's; a deploy, money or secret step must be owned by the evaluator or a script`,
      };
    }
    const interrupting = input.interrupting ?? known?.interrupting;
    if (interrupting && (owner === "work" || owner === "review")) {
      return {
        ok: false,
        reason: "an interrupting step must be owned by the evaluator or a script",
      };
    }
    const ownerOnly = input.ownerOnly ?? known?.ownerOnly;
    if (ownerOnly && (owner === "work" || owner === "review")) {
      return { ok: false, reason: "an owner-only step must be owned by the evaluator or a script" };
    }
    const { gate, gateSource, previousGate, keepClear } = planGate(
      input,
      owner,
      text,
      ownerOnly,
      interrupting,
      known,
    );
    const script =
      (input.script ?? (reason !== undefined ? known?.script : undefined))?.trim() || undefined;
    if (script && owner !== "script") {
      return {
        ok: false,
        reason: `subtask "${text}" names a script, so its owner must be "script"`,
      };
    }
    if (input.step !== undefined && (!Number.isInteger(input.step) || input.step < 1)) {
      return { ok: false, reason: "a subtask's step is a whole number from 1" };
    }
    step = input.step ?? known?.step ?? step + 1;
    if (known) {
      const {
        script: _old,
        gate: _oldGate,
        gateSource: _oldSource,
        gateCleared: _oldClear,
        ...rest
      } = known;
      // Rewording in the same edit cannot turn a deliberate gate into a guessed one.
      const clearing =
        reason !== undefined && owner !== "work" && owner !== "review"
          ? (previousGate ?? gate)
          : undefined;
      if (
        clearing &&
        (known.gateSource === "set" ||
          known.ownerOnly ||
          known.interrupting ||
          ownerOnly ||
          interrupting)
      ) {
        return {
          ok: false,
          code: "denied",
          reason: `subtask ${known.id} has a ${clearing} gate set on purpose; only Abdullah's answer clears it (card_ask naming ${known.id})`,
        };
      }
      if (clearing && (!actor || !at))
        return { ok: false, reason: "clearGate needs the clearing actor and time" };
      const gateCleared =
        clearing && actor && at
          ? { gate: clearing, reason: reason!, by: actor, at, text }
          : keepClear
            ? known.gateCleared
            : undefined;
      // Cosmetic edits keep the approval's time bound, including its absence on legacy plans.
      const approvalChanged =
        gate !== previousGate ||
        (input.gate != null && gateSource === "set" && known.gateSource !== "set") ||
        script !== known.script ||
        approvalText(text) !== approvalText(known.text);
      planned.push({
        ...rest,
        step,
        text,
        owner,
        ...(ownerOnly === undefined ? {} : { ownerOnly }),
        ...(interrupting === undefined ? {} : { interrupting }),
        ...(gate === undefined || clearing ? {} : { gate, gateSource }),
        ...(gateCleared ? { gateCleared } : {}),
        ...(approvalChanged && gate && !clearing && at ? { createdAt: at } : {}),
        ...(script ? { script } : {}),
      });
    } else {
      nextId += 1;
      planned.push({
        id: `s${nextId}`,
        step,
        text,
        owner,
        ...(ownerOnly === undefined ? {} : { ownerOnly }),
        ...(interrupting === undefined ? {} : { interrupting }),
        ...(gate === undefined ? {} : { gate, gateSource }),
        ...(at ? { createdAt: at } : {}),
        ...(script ? { script } : {}),
        state: "open",
        note: null,
        doneBy: null,
        doneAt: null,
      });
    }
  }
  const kept = existing
    .filter((subtask) => !listed.has(subtask.id) && subtask.state !== "open")
    .map((subtask) => {
      if (subtask.owner !== "work") return subtask;
      const { gate: _oldGate, ...rest } = subtask;
      return rest;
    });
  const subtasks = [...planned, ...kept].toSorted((a, b) => a.step - b.step);
  if (subtasks.length > MAX_SUBTASKS) {
    return { ok: false, reason: `a card has at most ${MAX_SUBTASKS} subtasks` };
  }
  return { ok: true, subtasks, subtaskSeq: nextId };
}

/** Whether `role` may set subtask `id` to `state`. */
export function checkMark(
  card: Pick<KanbanCard, "number" | "subtasks">,
  id: string,
  state: KanbanSubtask["state"],
  role: SubtaskRole,
  note: string | null,
  scriptName: string | null = null,
): MarkCheck {
  const subtask = card.subtasks.find((candidate) => candidate.id === id);
  if (!subtask)
    return {
      ok: false,
      denyReason: "subtask_not_found",
      reason: `card #${card.number} has no subtask ${id}. Existing subtask ids: ${subtaskIds(card.subtasks) || "none"}`,
    };
  if (subtask.state === state)
    return {
      ok: false,
      denyReason: "subtask_state_unchanged",
      reason: `subtask ${id} is already ${state}`,
    };
  if (state === "skipped" && !note?.trim()) {
    return {
      ok: false,
      denyReason: "skip_note_required",
      reason: "say why the subtask is skipped",
    };
  }
  if (role === "evaluator") return { ok: true };
  if (role === "review") {
    return {
      ok: false,
      denyReason: "review_verdict_required",
      reason: "a review ticks its subtasks with its verdict (card_review_result)",
    };
  }
  if (state === "open")
    return {
      ok: false,
      denyReason: "role_not_allowed",
      reason: "only an evaluator reopens a subtask",
    };
  if (subtask.owner !== role) {
    return {
      ok: false,
      denyReason: "subtask_owner_mismatch",
      reason: `subtask ${id} is for the ${OWNER_NAMES[subtask.owner]}, not you`,
    };
  }
  if (
    role === "script" &&
    subtask.script !== undefined &&
    subtask.script.toLowerCase() !== (scriptName ?? "").toLowerCase()
  ) {
    return {
      ok: false,
      denyReason: "subtask_script_mismatch",
      reason: `subtask ${id} is for the script "${subtask.script}"`,
    };
  }
  if (subtask.step !== kanbanOpenStep(card)) {
    return {
      ok: false,
      denyReason: "subtask_not_in_current_step",
      reason: `subtask ${id} is in step ${subtask.step}; finish step ${kanbanOpenStep(card)} first`,
    };
  }
  return { ok: true };
}

/** A script hands its subtask back to the evaluator: it must be an open one of its own, on the open step. */
export function checkHandBack(
  card: Pick<KanbanCard, "number" | "subtasks">,
  id: string,
  scriptName: string,
  note: string,
): MarkCheck {
  const subtask = card.subtasks.find((candidate) => candidate.id === id);
  if (!subtask)
    return {
      ok: false,
      denyReason: "subtask_not_found",
      reason: `card #${card.number} has no subtask ${id}. Existing subtask ids: ${subtaskIds(card.subtasks) || "none"}`,
    };
  if (!note.trim())
    return {
      ok: false,
      denyReason: "handoff_note_required",
      reason: "say what failed or didn't match",
    };
  if (subtask.owner !== "script")
    return {
      ok: false,
      denyReason: "subtask_owner_mismatch",
      reason: `subtask ${id} isn't a script's`,
    };
  if (subtask.state !== "open") {
    return {
      ok: false,
      denyReason: "subtask_not_open",
      reason: `subtask ${id} is already ${subtask.state}`,
    };
  }
  if (subtask.script !== undefined && subtask.script.toLowerCase() !== scriptName.toLowerCase()) {
    return {
      ok: false,
      denyReason: "subtask_script_mismatch",
      reason: `subtask ${id} is for the script "${subtask.script}"`,
    };
  }
  if (subtask.step !== kanbanOpenStep(card)) {
    return {
      ok: false,
      denyReason: "subtask_not_in_current_step",
      reason: `subtask ${id} is in step ${subtask.step}; finish step ${kanbanOpenStep(card)} first`,
    };
  }
  return { ok: true };
}

/** Gives a script's open subtask to the evaluator, with the note saying what failed. */
export const handBack = (
  subtasks: ReadonlyArray<KanbanSubtask>,
  id: string,
  note: string,
): ReadonlyArray<KanbanSubtask> =>
  subtasks.map((subtask) => {
    if (subtask.id !== id) return subtask;
    const { script: _script, ...rest } = subtask;
    return { ...rest, owner: "evaluator", note };
  });

export const markSubtask = (
  subtasks: ReadonlyArray<KanbanSubtask>,
  id: string,
  state: KanbanSubtask["state"],
  note: string | null,
  by: KanbanActor,
  at: string,
): ReadonlyArray<KanbanSubtask> =>
  subtasks.map((subtask) => {
    if (subtask.id !== id) return subtask;
    const { gateSkipped, ...rest } = subtask;
    return state === "open"
      ? { ...rest, state, note: null, doneBy: null, doneAt: null }
      : {
          ...rest,
          ...(state === "skipped" && gateSkipped ? { gateSkipped } : {}),
          state,
          note: note?.trim() || null,
          doneBy: by,
          doneAt: at,
        };
  });

export function reviewSubtasksToPass(card: Pick<KanbanCard, "subtasks">) {
  const current = kanbanOpenStep(card);
  if (current === null) return [];
  const open = card.subtasks.filter(
    (subtask) => subtask.owner === "review" && subtask.state === "open",
  );
  const step = Math.min(...open.map((subtask) => subtask.step));
  // Unfinished work in the current step can already have been reviewed, but
  // future work must get its turn before its review can pass.
  if (
    card.subtasks.some(
      (subtask) =>
        subtask.owner === "work" &&
        subtask.state === "open" &&
        subtask.step > current &&
        subtask.step <= step,
    )
  )
    return [];
  return open.filter((subtask) => subtask.step === step);
}

/** Earlier unfinished work must not hide the review step that just passed. */
export function passReview(
  card: Pick<KanbanCard, "subtasks">,
  by: KanbanActor,
  at: string,
): ReadonlyArray<KanbanSubtask> {
  const ids = new Set(reviewSubtasksToPass(card).map((subtask) => subtask.id));
  return card.subtasks.map((subtask) =>
    ids.has(subtask.id)
      ? { ...subtask, state: "done", note: "Review passed", doneBy: by, doneAt: at }
      : subtask,
  );
}

/**
 * Stages a card goes back to work from once its plan's next step is the
 * worker's, when no thread is on it. Todo is already there; working always has
 * a live thread; in_review has none once its review passed and it waits for
 * its PRs; needs_owner waits on the owner's answer.
 */
export const BACK_TO_WORK_FROM: ReadonlySet<KanbanCard["stage"]> = new Set([
  "needs_review",
  "in_review",
  "completed",
  "deployed",
  "verified",
]);

/** After a passed review: whether the step the card is on now has work for its worker. */
export const workAfterReview = (card: Pick<KanbanCard, "subtasks">) =>
  kanbanStepSubtasks(card, "work").length > 0;

export const OWNER_NAMES: Record<KanbanSubtask["owner"], string> = {
  work: "worker",
  review: "reviewer",
  evaluator: "evaluator",
  script: "script",
};

/** The plan as brief lines, with what's done and what's next. */
export function subtaskLines(card: Pick<KanbanCard, "subtasks">): string | null {
  if (card.subtasks.length === 0) return null;
  const current = kanbanOpenStep(card);
  const rows = card.subtasks.map((subtask) => {
    const mark =
      subtask.state === "done"
        ? "done"
        : subtask.state === "skipped"
          ? "skipped"
          : subtask.step === current
            ? "now"
            : "later";
    const note = subtask.note ? `: ${subtask.note}` : "";
    const owner =
      subtask.script === undefined
        ? OWNER_NAMES[subtask.owner]
        : `${OWNER_NAMES[subtask.owner]} "${subtask.script}"`;
    return `- ${subtask.id} step ${subtask.step}, ${owner} (${mark}${note}): ${subtask.text}`;
  });
  return `Subtasks (same step means any order; a step opens when the ones before are done or skipped):\n${rows.join("\n")}`;
}

/** Only the lead is stored; briefs render the plan from the card at delivery. */
export const nextStepNote = (lead = "") =>
  `${lead}Do this step's work subtasks, mark each with subtask_done, then card_move to needs_review.`;

/** Remove plans frozen by older releases, retaining text before and after them. */
export const wakeLead = (note: string | null): string | null => {
  const lead = note
    ?.replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(
      /Next on the plan:\nSubtasks \(same step means any order;[\s\S]*?Do this step's work subtasks, mark each with subtask_done, then card_move to needs_review\./g,
      "",
    )
    .replace(
      /Do this step's work subtasks, mark each with subtask_done, then card_move to needs_review\./g,
      "",
    )
    .trim();
  return lead || null;
};

/** Keep human context while discarding instructions for a finished/removed worker step. */
export const pendingWakeNote = (card: Pick<KanbanCard, "wakeNote" | "subtasks">) => {
  const lead = wakeLead(card.wakeNote);
  let findings = false;
  const cleaned = lead
    ?.split("\n")
    .map((line) => {
      // Findings refer to completed work precisely because it needs fixing;
      // only standalone queued instructions outside that section are obsolete.
      if (/^Review findings \(round \d+\):/.test(line)) findings = true;
      if (findings) {
        if (line === "Fix them, then card_move to needs_review.") findings = false;
        return line;
      }
      const prefix = line.match(/^\s*(?:[-*+]|\d+[.)])\s+/)?.[0] ?? "";
      const body = line.slice(prefix.length);
      const kept = body.split(/(?<=[.!?;])\s+/).filter((instruction) => {
        const request = instruction.trim().match(/^(?:Do\s+(s\d+)\b|(s\d+)\s*:)/i);
        const target = (request?.[1] ?? request?.[2])?.toLowerCase();
        return (
          !target ||
          card.subtasks.some((s) => s.id === target && s.owner === "work" && s.state === "open")
        );
      });
      return kept.length > 0 ? prefix + kept.join(" ") : "";
    })
    .join("\n")
    .trim();
  return cleaned || null;
};

/** Ids of open subtasks, for refusals: "s1, s3". */
export const subtaskIds = (subtasks: ReadonlyArray<KanbanSubtask>) =>
  subtasks.map((subtask) => subtask.id).join(", ");
