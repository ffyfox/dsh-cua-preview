/**
 * Browser bundle for dsh-cua-preview — the Client half.
 *
 * **One rendering contribution, on a documented seam: the keyed tool row.**
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
 *    **Once the call has settled**, the row paints the frames of the gated action in the order they
 *    happened: the frame the user was shown when they approved ("before the action") first, the frame
 *    after the action below it, so the row reads as a timeline. Both are references inside the call's
 *    own `tool/result` content, which is what makes them readable: the Host authorizes an attachment
 *    read by scanning the Session log for a known event whose content carries the reference
 *    (`dsh-api-session-controller`: `referencedImage` → `data.content` / `data.message.content` /
 *    `data.inserted[].content` / assistant stream chunks), otherwise `ATTACHMENT_NOT_REFERENCED`.
 *    `presentationMeta.frames` names each image's role, so the captions come from the *roles*
 *    rather than from position or from `granted` alone.
 *
 *    **An earlier revision carried the approval-time frame on a plugin-owned `cua/preview` event.**
 *    That event type is outside the harness's `KNOWN_SESSION_EVENT_TYPES`, and a live
 *    `Session.append()` cannot set the envelope's `ignorable: true` marker, so the persistence
 *    reader refused every session that had run a gated action
 *    ("contains event type \"cua/preview\" … unknown to this harness and not marked ignorable;
 *    refusing to interpret the log"). The plugin-author rule is explicit
 *    (`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`): "Do not append
 *    session events with a new `type` … live `Session.append()` cannot set that marker, so the
 *    Session would refuse to reopen." No definition over a plugin-owned event exists any more, and
 *    nothing in this bundle depends on one.
 *
 *    **The stage a call is in arrives as an explicit prop from DSH 0.2.0-rc.2 on.** That release
 *    replaced the single frozen `block` with a `phase` discriminant (`'preparing' | 'start' |
 *    'result'`) beside a stage-specific block (`PreparingToolCall` / `StartedToolCall` /
 *    `ToolResultNode`), and a `preparing` block carries no `argsRaw` at all. This view accepts both
 *    spellings — the package still declares support back to `0.1.5-rc.2`, where the stage had to be
 *    inferred from the result node's `kind` — preferring `phase` whenever the host supplies it, so
 *    a stage this build has never heard of degrades to "still running" instead of throwing.
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

		/**
		 * The caption for each frame role `presentationMeta.frames` can name. The role — not the
		 * image's position and not `granted` alone — decides the caption, so a grant whose
		 * post-action capture failed still labels its single frame "before the action".
		 */
		const FRAME_CAPTIONS = {
			before: "before the action",
			after: "after the action"
		};

		/** The caption a refusal's single frame carries: nothing ran, so it IS the approval-time state. */
		const REFUSAL_CAPTION = "at approval time (no action ran)";

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
		 * Caption the image at one position of a gated result.
		 *
		 * `presentationMeta.frames` names each image's role in presentation order, which is the whole
		 * reason it is persisted: the card must not infer a role from an image's position, and a
		 * missing frame must not shift its neighbour's caption. The before-frame says nothing ran
		 * when the action was refused, because that is what the reader needs to know.
		 *
		 * A result without a usable role list falls back to the rule an earlier build obeyed — one
		 * image per gated result, captioned from `granted` — and only for exactly that shape: one
		 * label over two different pictures would be a claim this result cannot back.
		 *
		 * @param meta - the persisted metadata, or null.
		 * @param index - the image's position in the result content.
		 * @param imageCount - how many images this result carries.
		 * @returns a caption, or null to render without one.
		 */
		function frameCaption(meta, index, imageCount) {
			if (meta === null) return null;
			if (Array.isArray(meta.frames)) {
				const role = meta.frames[index];
				if (role === "before") return meta.granted === false ? REFUSAL_CAPTION : FRAME_CAPTIONS.before;
				// An unknown role renders uncaptioned rather than mislabelled: a log another build
				// wrote must never gain a claim this one cannot back.
				return role === "after" ? FRAME_CAPTIONS.after : null;
			}
			if (imageCount !== 1) return null;
			if (meta.granted === true) return FRAME_CAPTIONS.after;
			if (meta.granted === false) return REFUSAL_CAPTION;
			return null;
		}

		/**
		 * The conversation row for browser_act / browser_navigate / browser_screenshot.
		 *
		 * Once the call has settled, the row paints the frames of that gated action in the order they
		 * happened: the frame the user was shown when they approved first, then the frame after the
		 * action, each under the caption `presentationMeta.frames` assigns it, both read through
		 * `loadImage` because both are references in this call's own result content. See the file
		 * header.
		 *
		 * A refusal has no post-action state, so its single frame *is* the approval-time one and its
		 * caption says so.
		 *
		 * @param props.phase - the lifecycle stage, when the host declares one (DSH >= 0.2.0-rc.2).
		 * @param props.block - the frozen stage block: running call or settled result node.
		 * @param props.loadImage - session-authorized image loader.
		 */
		function CuaRow({ phase, block, loadImage }) {
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

			for (let i = 0; i < texts.length; i += 1) {
				children.push(jsx("div", { style: S.text, children: texts[i] }, `text-${i}`));
			}

			if (loadImage !== undefined && loadImage !== null) {
				for (let i = 0; i < images.length; i += 1) {
					const caption = frameCaption(meta, i, images.length);
					if (caption !== null) {
						children.push(jsx("div", { style: S.caption, children: caption }, `caption-${i}`));
					}
					children.push(jsx(CuaImage, { image: images[i], loadImage }, `image-${i}`));
				}
			}

			return jsx("div", { style: S.card, children });
		}

		/** Tool names this view owns. An unclaimed key falls back to the generic row. */
		const TOOL_KEYS = ["browser_act", "browser_navigate", "browser_screenshot"];

		/** The slot registry this plugin contributes rows to. */
		const inject = ["slots"];

		/**
		 * Claim one keyed Tool-call view per browser tool.
		 *
		 * The frames of a *settled* call arrive inside the call's own result, so the row needs no event
		 * definition, no carrier node and no session hook for those; it renders them from its owner
		 * props.
		 *
		 * `conversation.approval.detail` is deliberately absent — the shipped `dsh-client-ui-chat`
		 * owns that `single` slot at priority 0, and a second same-priority registration throws
		 * inside ui-chat's apply and takes the whole client plugin load down with it. See the file
		 * header.
		 *
		 * @param ctx - the Client plugin context.
		 */
		function apply(ctx) {
			for (const key of TOOL_KEYS) {
				ctx.slots.inject("tool.call.toolview", () =>
					ctx.slots.register({ name: "tool.call.toolview", key, locale: NS }, CuaRow)
				);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.TOOL_KEYS = TOOL_KEYS;
		exports.FRAME_CAPTIONS = FRAME_CAPTIONS;
		exports.REFUSAL_CAPTION = REFUSAL_CAPTION;
		return module.exports;
	}
});
