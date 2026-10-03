/**
 * Browser bundle for dsh-cua-preview — the Client half.
 *
 * **One rendering contribution plus one data carrier**, both on documented seams:
 *
 * 1. **Tool rows** (`tool.call.toolview`, keyed per browser tool). The built-in Web Client only
 *    paints a durable tool image when the tool has registered a view for that slot; its shipped
 *    keys are ask_user_question/bash/edit/glob/grep/read/read_image/todo_write/web_fetch/
 *    web_search/write, so `browser_act` screenshots reached the model but were invisible in the
 *    conversation. The `tool.call.images` child slot is `kind: 'single'` and already claimed by the
 *    shipped `read_image` view, and a second declaration throws at load, so this view does not
 *    declare that child; it renders durable images itself through the session-authorized
 *    `loadImage` loader it receives in its owner props. That is the "own a distinct slot" route the
 *    slot contract names.
 *
 *    **One row paints both frames, in the order they happened.** The approval-time frame ("before
 *    the action") is rendered first and the result frame ("after the action") below it, so the row
 *    reads as a timeline. Ordering inside one row is ours to guarantee; ordering *between* rows is
 *    not. An earlier revision published the approval-time frame as its own visible Chat node, and
 *    that node sorted *below* the tool row, because the chat orders nodes by `anchorSeq`
 *    (`orderedVisibleChatNodes`, `dsh-client-ui-chat`) and the tool row's anchor is the `tool/call`
 *    event — which the Host appends *before* it asks for approval, so the preview event always has
 *    the larger seq. The result was the frame the user was meant to review sitting under the frame
 *    that only exists after they reviewed it.
 *
 *    **The stage a call is in arrives as an explicit prop from DSH 0.2.0-rc.2 on.** That release
 *    replaced the single frozen `block` with a `phase` discriminant (`'preparing' | 'start' |
 *    'result'`) beside a stage-specific block (`PreparingToolCall` / `StartedToolCall` /
 *    `ToolResultNode`), and a `preparing` block carries no `argsRaw` at all. This view accepts both
 *    spellings — the package still declares support back to `0.1.5-rc.2`, where the stage had to be
 *    inferred from the result node's `kind` — preferring `phase` whenever the host supplies it, so
 *    a stage this build has never heard of degrades to "still running" instead of throwing.
 *
 * 2. **A hidden data node carrying the approval-time frame** (`ConversationNodeDefinition` over the
 *    plugin-owned `cua/preview` event, kind `cua-preview`, `visibility: 'hidden'`). A tool row
 *    cannot show anything while its call is still running — its content and metadata arrive with
 *    the result — so the frame has to reach the Client by another route, and
 *    `docs/subsystems/conversation.md` documents exactly this one: a plugin-owned event family
 *    matched by a Definition whose `buildViewNode` publishes a target-owned node. The row then
 *    finds its own frame by `callId` through the session-scoped standard hook `useChat`
 *    (`ctx.uiSession.provide({ hooks: ['chat'] })` in `dsh-client-ui-chat`; `ui-tool` declares
 *    `tool.call.toolview` as `scope: 'session'`, `children: { 'tool.call.toolview': { kind: 'keyed',
 *    scope: 'session' } }`, so the kit is strict — a slot rendered without it throws rather than
 *    silently losing the hook).
 *
 *    `visibility: 'hidden'` is what makes the node a *carrier* rather than a second, misplaced
 *    copy: the chat's node store keeps it (`ChatNodeStore.get` is documented as "current Node, when
 *    visible or hidden"; the store is built from every upsert and only the render order filters on
 *    `visibility === 'visible'`), while the visible flow — and with it the turn-process disclosure
 *    member count — ignores it. Nothing is registered into `conversation.chat.node`, because a
 *    hidden node never reaches the seat that would dispatch such a renderer.
 *
 * **The approval panel's detail region is deliberately NOT claimed, and this is a hard
 * constraint rather than a preference.** The region looks ideal (the panel renders it inside the
 * card, above the decision buttons), but `conversation.approval.detail` is `kind: 'single'`, and the
 * shipped `@deepseek-ai/dsh-client-ui-chat` ALREADY registers into it at priority 0:
 *
 * ```js
 * ctx.slots.inject("conversation.approval.detail", () =>
 *   ctx.slots.register({ name: "conversation.approval.detail" }, ApprovalCommand))
 * ```
 *
 * `ApprovalCommand` is the command preview for the pending call. `dsh-client-ui-slots`'s
 * `SlotCore.register` rejects a second `single`-slot registration at the same priority:
 *
 * ```js
 * case "single": {
 *   const occupant = rec.entries.find((e) => (e.options.priority ?? 0) === priority)
 *   if (occupant) throw new Error(`single slot "${options.name}" already has a registration …`)
 * ```
 *
 * and that throw happens inside *ui-chat's* apply, so claiming the slot does not merely fail here —
 * it fails the whole client plugin load ("Failed to load plugins … @deepseek-ai/dsh-client-ui-chat").
 * Registering at a lower priority instead would shadow the shipped command preview for every tool.
 * An earlier revision did claim it and produced exactly that boot failure; the verifier now asserts
 * this slot is left untouched.
 *
 * `meta` alone is NOT enough to load any of these. The Host authorizes an attachment read by
 * scanning the Session log for an event whose content carries that reference
 * (`dsh-api-session-controller`: `referencedImage` → `data.content` / `data.message.content` /
 * `data.inserted[].content` / assistant stream chunks, otherwise `ATTACHMENT_NOT_REFERENCED`), and
 * `meta` is none of those positions — a card built on `meta` alone renders
 * "screenshot could not be loaded". The Host half therefore references the frame from a
 * plugin-owned log-only `cua/preview` event; every view here is backed by that event.
 *
 * Format matches the loader contract the shipped client bundles use
 * (`@deepseek-ai/dsh-client-ui-approval/lib/client.js`): `window.__ModuleLoader__.load({id, factory})`.
 */

window.__ModuleLoader__.load({
	id: "dsh-cua-preview",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");

		/** The locale namespace the shipped tool rows use. */
		const NS = "conversation";

		/** The plugin-owned event type carrying the approval-time frame. */
		const PREVIEW_EVENT = "cua/preview";

		/** The Definition kind the hidden carrier node is published under. */
		const PREVIEW_KIND = "cua-preview";

		/** The view target the carrier node is published to. */
		const CHAT_TARGET = "chat";

		/**
		 * The carrier node never reaches the visible flow: the chat's render order filters on
		 * `visibility === 'visible'` (`orderedVisibleChatNodes`), while `ChatNodeStore.values()`
		 * keeps every materialized node — the store's own type documents `get(key)` as "current
		 * Node, when visible or hidden". Hidden is therefore how one live carrier exists in Client
		 * state without painting a second, misordered copy of the frame.
		 */
		const CARRIER_VISIBILITY = "hidden";

		/** The caption for the approval-time frame; the result frame says "after the action". */
		const BEFORE_CAPTION = "before the action";

		/** Inline styles: no CSS injection, so there is no stylesheet tag to own or clean up. */
		const S = {
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				padding: "8px 4px 4px"
			},
			head: {
				display: "flex",
				alignItems: "baseline",
				gap: "8px",
				minWidth: 0
			},
			name: {
				fontSize: "13px",
				lineHeight: "20px",
				color: "var(--dsw-alias-label-secondary)",
				fontFamily: "var(--ds-font-family-code)",
				flex: "none"
			},
			summary: {
				fontSize: "13px",
				lineHeight: "20px",
				color: "var(--dsw-alias-label-tertiary)",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				minWidth: 0
			},
			text: {
				fontSize: "13px",
				lineHeight: "20px",
				color: "var(--dsw-alias-label-tertiary)",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				fontFamily: "var(--ds-font-family-code)"
			},
			image: {
				display: "block",
				width: "100%",
				maxWidth: "640px",
				height: "auto",
				borderRadius: "12px",
				border: "0.5px solid var(--dsw-alias-border-l2)"
			},
			caption: {
				fontSize: "12px",
				lineHeight: "18px",
				color: "var(--dsw-alias-label-caption)"
			},
			imageFallback: {
				fontSize: "13px",
				lineHeight: "20px",
				color: "var(--dsw-alias-label-tertiary)",
				border: "0.5px dashed var(--dsw-alias-border-l2)",
				borderRadius: "12px",
				padding: "10px 12px"
			}
		};

		/**
		 * Read the call's JSON arguments.
		 *
		 * A malformed or older logged call returns null rather than throwing: display must never
		 * crash a replay of a session written by another build.
		 *
		 * @param block - running Tool call or settled Tool result node.
		 * @returns the parsed arguments object, or null.
		 */
		function parsedArgs(block) {
			const call = "kind" in block ? block.call : block;
			if (call === null || typeof call !== "object") return null;
			if (typeof call.argsRaw !== "string") return null;
			let value;
			try {
				value = JSON.parse(call.argsRaw);
			} catch {
				return null;
			}
			if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
			return value;
		}

		/** Collect the result's text blocks. */
		function collectTexts(content) {
			if (!Array.isArray(content)) return [];
			const out = [];
			for (const part of content) {
				if (part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
					out.push(part.text);
				}
			}
			return out;
		}

		/**
		 * Validate one durable image reference.
		 *
		 * @param value - a candidate `ImageAttachmentRef`.
		 * @returns the reference, or null when it is malformed.
		 */
		function validImageRef(value) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
			if (typeof value.attachmentId !== "string" || value.attachmentId === "") return null;
			if (typeof value.mediaType !== "string" || !value.mediaType.startsWith("image/")) return null;
			return value;
		}

		/**
		 * Collect the result's durable image references.
		 *
		 * Mirrors the shipped card's strictness: one malformed reference abandons the whole
		 * gallery rather than rendering a partial, misleading set.
		 */
		function collectImages(content) {
			if (!Array.isArray(content)) return [];
			const out = [];
			for (const part of content) {
				if (part === null || typeof part !== "object" || part.type !== "image") continue;
				const a = validImageRef(part.attachment);
				if (a === null) return [];
				out.push(a);
			}
			return out;
		}

		/**
		 * Read the persisted `presentationMeta` projection off a settled result.
		 *
		 * The Host projects it with `output.presentationMeta`, the core persists it as
		 * `result.meta`, and the session log transports it — so a card can caption result-time
		 * facts the model-facing content does not carry (`docs/cookbook/adding-a-tool.md`).
		 * Malformed metadata is ignored rather than thrown: display must never crash a replay.
		 *
		 * @param block - a settled Tool result node.
		 * @returns the metadata object, or null.
		 */
		function readMeta(block) {
			const meta = block.meta;
			if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
			return meta;
		}

		/**
		 * One durable screenshot, resolved to a session-authorized URL.
		 *
		 * @param props.image - the `ImageAttachmentRef` to display.
		 * @param props.loadImage - the session-authorized loader; `peek` reads a cached URL.
		 */
		function CuaImage({ image, loadImage }) {
			const [url, setUrl] = react.useState(() => {
				if (typeof loadImage?.peek !== "function") return null;
				const peeked = loadImage.peek(image);
				return typeof peeked === "string" ? peeked : null;
			});
			const [failed, setFailed] = react.useState(false);

			react.useEffect(() => {
				if (url !== null || failed) return undefined;
				let alive = true;
				Promise.resolve()
					.then(() => loadImage(image))
					.then((next) => {
						if (alive && typeof next === "string") setUrl(next);
					})
					.catch(() => {
						if (alive) setFailed(true);
					});
				return () => {
					alive = false;
				};
			}, [image, loadImage, url, failed]);

			if (failed) return jsx("div", { style: S.imageFallback, children: "screenshot could not be loaded" });
			if (url === null) return jsx("div", { style: S.imageFallback, children: "loading screenshot…" });
			return jsx("img", { src: url, alt: "Browser screenshot", style: S.image });
		}

		/**
		 * Find the approval-time frame belonging to one tool call.
		 *
		 * The carrier Definition below publishes one hidden node per `cua/preview` event; this reads
		 * the frame back by the call id recorded beside it. The scan is the same shape the shipped
		 * `ApprovalCommand` uses to find its pending call's command
		 * (`dsh-client-ui-chat`'s `useChat((snapshot) => …snapshot.nodes.values()…)`), and it is
		 * bounded by the loaded window's node count.
		 *
		 * The returned value is the attachment object held in the Definition's State, so it is
		 * reference-stable across publishes — which `useChat` requires, because it compares
		 * selections with `Object.is` (`useSyncExternalStoreWithSelector` without a custom
		 * comparator). Returning a fresh object here would re-render forever.
		 *
		 * @param snapshot - the Chat snapshot handed to the selector.
		 * @param callId - the tool call this row belongs to.
		 * @returns the durable reference to display, or null when this call has no frame.
		 */
		function previewImageOf(snapshot, callId) {
			if (snapshot === null || typeof snapshot !== "object") return null;
			const nodes = snapshot.nodes;
			if (nodes === null || typeof nodes !== "object" || typeof nodes.values !== "function") return null;
			for (const candidate of nodes.values()) {
				if (candidate === null || typeof candidate !== "object") continue;
				if (candidate.kind !== PREVIEW_KIND) continue;
				const data = candidate.data;
				if (data === null || typeof data !== "object") continue;
				if (callId !== undefined && callId !== null && data.callId !== callId) continue;
				const image = validImageRef(data.attachment);
				if (image !== null) return image;
			}
			return null;
		}

		/**
		 * The lifecycle stage a Tool view is being rendered for.
		 *
		 * DSH 0.2.0-rc.2 hands the view an explicit `phase` beside a stage-specific `block`
		 * (`{phase: 'preparing', block: PreparingToolCall}` / `{phase: 'start', block: StartedToolCall}`
		 * / `{phase: 'result', block: ToolResultNode}`). Up to 0.1.5-rc.3 there was no `phase`: one
		 * frozen block arrived and the stage had to be inferred from `kind`, which only the result
		 * node carries. Both spellings are accepted, with the declared one preferred; a stage this
		 * build has never heard of falls back to the `kind` rule, so an unknown future stage paints
		 * strictly less than a result rather than throwing.
		 *
		 * @param phase - the owner's stage prop, when the host supplies one.
		 * @param block - the stage block handed to the view.
		 * @returns {'preparing'|'start'|'result'} the stage to render.
		 */
		function stageOf(phase, block) {
			// `PreparingToolCall` / `StartedToolCall` also carry `phase` themselves, so the block is
			// consulted only when the owner passed no prop.
			const onBlock = block !== null && typeof block === "object" && typeof block.phase === "string"
				? block.phase
				: null;
			const declared = typeof phase === "string" ? phase : onBlock;
			if (declared === "preparing" || declared === "start" || declared === "result") return declared;
			return block !== null && typeof block === "object" && "kind" in block ? "result" : "start";
		}

		/** A short one-line summary of what the call asked for. */
		function summarize(name, args, settled) {
			if (name === "browser_act") {
				const parts = [];
				if (typeof args.action === "string") parts.push(args.action);
				if (typeof args.selector === "string") parts.push(args.selector);
				if (parts.length > 0) return parts.join(" ");
			} else if (name === "browser_navigate") {
				if (typeof args.url === "string") return args.url;
			} else if (name === "browser_screenshot") {
				return typeof args.name === "string" ? args.name : "current screen";
			}
			return settled ? "done" : "running…";
		}

		/**
		 * Caption one result frame.
		 *
		 * The result carries at most one image and its caption comes from the persisted
		 * `presentationMeta`: a grant means the frame is the state after the action; a refusal
		 * means no action ran, so the frame is the approval-time state. A result with no metadata
		 * (a read-only screenshot) stays uncaptioned.
		 *
		 * @param meta - the persisted metadata, or null.
		 * @returns a caption, or null to render without one.
		 */
		function resultCaption(meta) {
			if (meta === null) return null;
			if (meta.granted === true) return "after the action";
			if (meta.granted === false) return "at approval time (no action ran)";
			return null;
		}

		/**
		 * The conversation row for browser_act / browser_navigate / browser_screenshot.
		 *
		 * One row paints both frames of one gated action in the order they happened: the
		 * approval-time frame first (live, from the hidden carrier node, so it is on screen while
		 * the approval is still pending), then the result frame with its caption. Ordering between
		 * separate rows is not ours to control — the chat sorts nodes by `anchorSeq`, and the tool
		 * row's anchor is the `tool/call` event, which precedes the approval event — so the row is
		 * the only place where "before above, after below" can be guaranteed. See the file header.
		 *
		 * A refusal has no post-action state, so the result's single frame *is* the approval-time
		 * one. Painting both would show the same picture twice; the frame is therefore dropped from
		 * the approval block and kept once, under its honest caption.
		 *
		 * @param props.phase - the lifecycle stage, when the host declares one (DSH >= 0.2.0-rc.2).
		 * @param props.block - the frozen stage block: running call or settled result node.
		 * @param props.callId - the tool call identity, matched against the carrier node.
		 * @param props.loadImage - session-authorized image loader.
		 * @param props.useChat - session-scoped selector hook over the Chat target.
		 */
		function CuaRow({ phase, block, callId, loadImage, useChat }) {
			// `tool.call.toolview` is declared `scope: 'session'`, and session-scoped entries get the
			// session standard kit strictly — a slot rendered without its sources throws at assembly
			// rather than quietly losing them — so this hook is present whenever the row renders.
			const selector = react.useMemo(
				() => (snapshot) => previewImageOf(snapshot, callId),
				[callId]
			);
			const approvalImage = useChat(selector);

			// A detached reader can hand back a null block for a log another build wrote. `in`
			// on null throws, so this is checked before anything else touches the value.
			if (block === null || typeof block !== "object") {
				return jsx("div", {
					style: S.card,
					children: jsx("div", { style: S.text, children: "browser call (unavailable)" })
				});
			}
			const stage = stageOf(phase, block);
			const settled = stage === "result";
			const call = settled ? block.call : block;
			const name = call !== null && typeof call === "object" && typeof call.name === "string"
				? call.name
				: "browser";
			const args = parsedArgs(block) ?? {};
			const texts = settled && Array.isArray(block.content) ? collectTexts(block.content) : [];
			const images = settled && block.isError !== true ? collectImages(block.content) : [];
			const meta = settled && block.isError !== true ? readMeta(block) : null;
			const caption = resultCaption(meta);
			const frameIsTheResultItself = approvalImage !== null &&
				images.some((image) => image.attachmentId === approvalImage.attachmentId);

			// A preparing call has no arguments yet, so there is nothing honest to summarise: the name
			// alone is painted instead of the "running…" placeholder, which would read as though the
			// action had already been described.
			const summary = stage === "preparing" ? null : summarize(name, args, settled);
			const head = [jsx("span", { style: S.name, children: name })];
			if (summary !== null && summary !== "") {
				head.push(jsx("span", { style: S.summary, children: summary }));
			}

			const children = [
				jsxs(
					"div",
					{
						style: S.head,
						children: head
					},
					"head"
				)
			];

			if (loadImage !== undefined && loadImage !== null) {
				// The approval-time frame first: this is the picture the user reviewed, and it stays
				// as the top of the row's timeline once the result frame arrives below it.
				if (approvalImage !== null && !frameIsTheResultItself) {
					children.push(jsx("div", { style: S.caption, children: BEFORE_CAPTION }, "before-caption"));
					children.push(jsx(CuaImage, { image: approvalImage, loadImage }, "before-image"));
				}
			}

			for (let i = 0; i < texts.length; i += 1) {
				children.push(jsx("div", { style: S.text, children: texts[i] }, `text-${i}`));
			}

			if (loadImage !== undefined && loadImage !== null) {
				if (images.length > 0 && caption !== null) {
					children.push(jsx("div", { style: S.caption, children: caption }, "caption"));
				}
				for (let i = 0; i < images.length; i += 1) {
					children.push(jsx(CuaImage, { image: images[i], loadImage }, `image-${i}`));
				}
			}

			return jsx("div", { style: S.card, children });
		}

		/**
		 * Read the approval-time frame out of one `cua/preview` event.
		 *
		 * The shape is the one the Host half appends: the reference sits in `content`, which is the
		 * position the Host's own attachment authorizer scans, and the correlation facts sit beside
		 * it. Anything malformed yields null, so a log written by another build renders nothing
		 * rather than crashing the transcript.
		 *
		 * @param event - a durable Session event.
		 * @returns `{attachment, callId, action, toolName}`, or null.
		 */
		function previewDataOf(event) {
			if (event === null || typeof event !== "object") return null;
			const data = event.data;
			if (data === null || typeof data !== "object") return null;
			const blocks = Array.isArray(data.content) ? data.content : [];
			let attachment = null;
			for (const part of blocks) {
				if (part !== null && typeof part === "object" && part.type === "image") {
					attachment = validImageRef(part.attachment);
					if (attachment !== null) break;
				}
			}
			if (attachment === null) return null;
			return {
				attachment,
				callId: typeof data.callId === "string" && data.callId !== "" ? data.callId : null,
				action: typeof data.action === "string" ? data.action : null,
				toolName: typeof data.toolName === "string" ? data.toolName : null
			};
		}

		/**
		 * The Conversation Definition for the plugin-owned `cua/preview` family.
		 *
		 * One event is one whole checkpoint, so it is its own start Match and there is nothing to
		 * fold: `update` only ever has to reject non-checkpoint events, which `match` never admits.
		 * The identity is the correlated tool call when there is one, which is how the row finds its
		 * own frame; the event's own `seq` is the fallback identity.
		 *
		 * The node it publishes is a **hidden carrier** — Client state the row reads, not a row of
		 * its own. See the file header for why the frame cannot be its own visible node.
		 */
		const PREVIEW_DEFINITION = {
			kind: PREVIEW_KIND,
			target: CHAT_TARGET,
			match: (event) => {
				if (event === null || typeof event !== "object" || event.type !== PREVIEW_EVENT) return null;
				const data = previewDataOf(event);
				if (data === null) return null;
				return { id: data.callId ?? String(event.seq), role: "start" };
			},
			start: (_context, match) => previewDataOf(match.event) ?? {
				attachment: null,
				callId: null,
				action: null,
				toolName: null
			},
			update: (context) => context.state,
			buildViewNode: (context) => {
				const state = context.state;
				if (state === undefined || state === null || validImageRef(state.attachment) === null) return null;
				return {
					key: context.key,
					kind: PREVIEW_KIND,
					id: context.id,
					target: CHAT_TARGET,
					anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
					location: context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" },
					visibility: CARRIER_VISIBILITY,
					data: state
				};
			}
		};

		/** Tool names this view owns. An unclaimed key falls back to the generic row. */
		const TOOL_KEYS = ["browser_act", "browser_navigate", "browser_screenshot"];

		/** The slot registry plus the Conversation assembly this plugin contributes a node to. */
		const inject = ["slots", "uiConversation"];

		/**
		 * Claim one keyed Tool-call view per browser tool, and register the carrier Definition the
		 * rows read their approval-time frame from.
		 *
		 * No renderer is registered into `conversation.chat.node`: the carrier is hidden, and the
		 * chat's render order only contains visible nodes, so a renderer for this kind would be dead
		 * code. `conversation.approval.detail` is deliberately absent too — the shipped
		 * `dsh-client-ui-chat` owns that `single` slot at priority 0, and a second same-priority
		 * registration throws inside ui-chat's apply and takes the whole client plugin load down
		 * with it. See the file header.
		 *
		 * @param ctx - the Client plugin context.
		 */
		function apply(ctx) {
			for (const key of TOOL_KEYS) {
				ctx.slots.inject("tool.call.toolview", () =>
					ctx.slots.register({ name: "tool.call.toolview", key, locale: NS }, CuaRow)
				);
			}

			ctx.uiConversation.events.register(PREVIEW_DEFINITION);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.TOOL_KEYS = TOOL_KEYS;
		exports.PREVIEW_KIND = PREVIEW_KIND;
		exports.PREVIEW_EVENT = PREVIEW_EVENT;
		return module.exports;
	}
});
