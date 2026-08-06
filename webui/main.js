/**
 * initial kityminder-editor
 */
const DEFAULT_MAP_TEMPLATE = "right";

function withDefaultKmTemplate(data, fileStem) {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return data;
	}

	if (Object.keys(data).length === 0) {
		data.root = { data: { text: fileStem || "" }, children: [] };
	} else if (
		data.root &&
		data.root.data &&
		typeof data.root.data.text === "string" &&
		!data.root.data.text &&
		fileStem
	) {
		data.root.data.text = fileStem;
	}
	if ((data.root || data.data) && !data.template) {
		data.template = DEFAULT_MAP_TEMPLATE;
	}
	return data;
}

window.infiniteMapWebviewSessionId =
	window.crypto && typeof window.crypto.randomUUID === "function"
		? window.crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const draftSuppressions = new Set();
window.mindmapSuppressDraft = false;
window.infiniteMapAcquireDraftSuppression = function (token) {
	draftSuppressions.add(token);
	window.mindmapSuppressDraft = true;
};
window.infiniteMapReleaseDraftSuppression = function (token) {
	draftSuppressions.delete(token);
	window.mindmapSuppressDraft = draftSuppressions.size > 0;
};
if (window.infiniteMapRefreshDraftSuppression) {
	window.infiniteMapAcquireDraftSuppression(window.infiniteMapRefreshDraftSuppression);
	window.infiniteMapRefreshDraftSuppression = undefined;
}

angular
	.module("kityminderDemo", ["kityminderEditor"])
	.config(function (configProvider) {
		let state = window.vscode.getState();
		if (state.lang) {
			configProvider.set("lang", state.lang);
		}
		if (state.upload_url) {
			configProvider.set("imageUpload", state.upload_url);
		}
		})
		.controller("MainController", function ($scope) {
			let importSequence = 0;

			function suppressDraft(token) {
				window.infiniteMapAcquireDraftSuppression(token);
			}

			function releaseDraft(token) {
				window.setTimeout(() => {
					window.infiniteMapReleaseDraftSuppression(token);
				}, 250);
		}

		function listenContentChange() {
			if (listenContentChange.listened) return;
			window.minder.on("contentchange", (e) => {
				if (window.mindmapSuppressDraft) return;
				if (window.fileExtName === ".svg") {
					window.minder.exportData("svg").then((data) => {
						window.vscode.postMessage({
							command: "draft",
							exportData: data,
						});
					});
				} else {
					window.vscode.postMessage({
						command: "draft",
						exportData: JSON.stringify(window.minder.exportJson(), null, 4),
					});
				}
			});
			listenContentChange.listened = true;
		}
		$scope.initEditor = function (editor, minder) {
			window.editor = editor;
			window.minder = minder;
			minder.setTemplate(DEFAULT_MAP_TEMPLATE);

			/**
			 * receive message event from extension
			 */
			window.addEventListener("message", function (event) {
				const message = event.data;
				window.message = message;
				const { command, extName } = message;
				if (extName) {
					window.fileExtName = extName;
				}

				switch (command) {
					case "import": {
						const suppressionToken = message.importRequestId || `import-${++importSequence}`;
						suppressDraft(suppressionToken);
						const importTask = Promise.resolve().then(() => {
							const importData = message.importData;
							if (extName === ".svg") {
								return window.minder.importData("svg", importData);
							}
							const parsedData = JSON.parse(importData || "{}");
							return window.minder.importJson(
								extName === ".km" ? withDefaultKmTemplate(parsedData, message.fileStem) : parsedData,
							);
						});
						const finishImport = (ok, error) => {
							releaseDraft(suppressionToken);
							listenContentChange();
							if (message.importRequestId) {
								window.vscode.postMessage({
									command: "importResult",
									importRequestId: message.importRequestId,
									ok,
									error: error ? String(error.message || error) : undefined,
								});
							}
						};
						importTask.then(
							() => finishImport(true),
							(error) => {
								console.error(error);
								finishImport(false, error);
							}
						);
						break;
					}
					case "requestSave":
						// VS Code native save channel: echo the request ID to reject stale responses.
						window.vscode.postMessage({
							command: "save",
							requestId: message.requestId,
							exportData: JSON.stringify(window.minder.exportJson(), null, 4),
						});
						break;
					case "ping":
						window.vscode.postMessage({ command: "pong", pingId: message.pingId });
						break;
					case "execState":
						// 并行执行旁车状态：供右下角节点卡片展示认领/租约信息
						window.kmExecState = message.tasks || {};
						document.dispatchEvent(new CustomEvent("km-exec-state"));
						break;
					case "reconnect":
						window.vscode.postMessage({
							command: "reconnected",
							reconnectId: message.reconnectId,
							exportData: JSON.stringify(window.minder.exportJson(), null, 4),
							webviewSessionId: window.infiniteMapWebviewSessionId,
							timestamp: new Date().toISOString(),
						});
						break;
				}
			});

			window.minder.on("click", (e) => {
				try {
					const link = e.minder.queryCommandValue("HyperLink");
					if (
						link &&
						link.url &&
						e.kityEvent.targetShape.container.getType() === "HyperLink"
					) {
						window.vscode.postMessage({
							command: "clicklink",
							link: link.url,
						});
					}
					// 捕获不到markdown中的链接点击,可能监听window可以做到
				} catch (e) {}
			});

				// Keep the original `loaded` handshake on the wire. Older extension
				// hosts can remain alive when a same-version VSIX is overwritten.
				window.vscode.postMessage({
					command: "loaded",
					webviewSessionId: window.infiniteMapWebviewSessionId,
					timestamp: new Date().toISOString(),
				});
		};
	});

(function () {
	$(document).on("click", ".nav-tabs a", function (event) {
		event.preventDefault();
	});

	$(document).on("click", ".export", function (event) {
		event.preventDefault();
		var $this = $(this),
			type = $this.data("type"),
			exportType;
		switch (type) {
			case "km":
				exportType = "json";
				break;
			case "xmind":
				exportType = "json";
				break;
			case "md":
				exportType = "markdown";
				break;
			case "svg":
				exportType = "svg";
				break;
			case "txt":
				exportType = "text";
				break;
			case "png":
				exportType = "svg";
				break;
			default:
				exportType = type;
				break;
		}

		editor.minder.exportData(exportType).then(function (content) {
			window.vscode.postMessage({
				command: "export",
				filename: $("#node_text1").text(),
				type: type,
				content,
			});
		});
	});

	// 导入
	$(document).on("click", ".import", function (event) {
		window.vscode.postMessage({
			command: "importFile",
		});
	});

	window.addEventListener("message", function (event) {
		let command = event.data.command;
		let content = event.data.content;
		let basename = event.data.basename;

		if (command == "importNewData") {
			var fileType = "";
			switch (basename) {
				case ".md":
					fileType = "markdown";
					break;
				case ".txt":
					fileType = "text";
					break;
				case ".km":
				case ".json":
					fileType = "json";
					break;
				case ".xmind":
					fileType = "json";
					break;
				default:
					fileType = "";
					break;
			}
			if (typeof content != "string") {
				content = JSON.stringify(content);
			}
			fileType &&
				editor.minder.importData(fileType, content).then(function (data) {
					var fileInput = document.getElementById("fileInput");
					fileInput && $(fileInput).val("");
				});
		}
	});
})();

//base64转换为图片blob
function dataURLtoBlob(dataurl) {
	var arr = dataurl.split(",");
	//注意base64的最后面中括号和引号是不转译的
	var _arr = arr[1].substring(0, arr[1].length - 2);
	var mime = arr[0].match(/:(.*?);/)[1],
		bstr = atob(_arr),
		n = bstr.length,
		u8arr = new Uint8Array(n);
	while (n--) {
		u8arr[n] = bstr.charCodeAt(n);
	}
	return new Blob([u8arr], {
		type: mime,
	});
}
