angular.module('kityminderEditor').directive('agentSessionLog', [
	'agentSessionI18n',
	function(agentSessionI18n) {
		return {
			restrict: 'A',
			replace: true,
			templateUrl: 'ui/directive/agentSessionLog/agentSessionLog.html',
			link: function(scope) {
				scope.sessionLog = {
					visible: false,
					collapsed: false,
					entries: [],
					currentTurn: null,
					autoScroll: true
				};

				var maxEntries = 500;
				var currentDelta = null;
				var deltaBuffer = '';
				var deltaTimeoutId = null;

				function addEntry(type, content, metadata) {
					var entry = {
						id: Date.now() + '-' + Math.random().toString(36).slice(2),
						type: type,
						content: content,
						metadata: metadata || {},
						timestamp: new Date().toISOString()
					};
					scope.sessionLog.entries.push(entry);
					if (scope.sessionLog.entries.length > maxEntries) {
						scope.sessionLog.entries.shift();
					}
					if (scope.sessionLog.autoScroll) {
						scrollToBottom();
					}
					return entry;
				}

				function scrollToBottom() {
					setTimeout(function() {
						var container = document.querySelector('.agent-session-log-content');
						if (container) {
							container.scrollTop = container.scrollHeight;
						}
					}, 50);
				}

				function flushDelta() {
					if (deltaTimeoutId) {
						clearTimeout(deltaTimeoutId);
						deltaTimeoutId = null;
					}
					if (currentDelta && deltaBuffer) {
						currentDelta.content = deltaBuffer;
						deltaBuffer = '';
					}
				}

				function appendDelta(text) {
					deltaBuffer += text;
					if (!currentDelta) {
						currentDelta = addEntry('message', deltaBuffer, { streaming: true });
					} else {
						currentDelta.content = deltaBuffer;
					}
					// 使用节流避免频繁更新
					if (deltaTimeoutId) {
						clearTimeout(deltaTimeoutId);
					}
					deltaTimeoutId = setTimeout(function() {
						flushDelta();
						scope.$apply();
					}, 100);
				}

				function finalizeDelta() {
					flushDelta();
					if (currentDelta) {
						currentDelta.metadata.streaming = false;
						currentDelta = null;
					}
					deltaBuffer = '';
				}

				scope.toggleLogPanel = function() {
					scope.sessionLog.collapsed = !scope.sessionLog.collapsed;
				};

				scope.clearLog = function() {
					scope.sessionLog.entries = [];
					currentDelta = null;
					deltaBuffer = '';
				};

				scope.toggleAutoScroll = function() {
					scope.sessionLog.autoScroll = !scope.sessionLog.autoScroll;
				};

				scope.getEntryIcon = function(entry) {
					switch (entry.type) {
						case 'message': return '💬';
						case 'tool-started': return '🔧';
						case 'tool-completed': return '✅';
						case 'tool-failed': return '❌';
						case 'state-change': return '🔄';
						case 'error': return '⚠️';
						default: return '•';
					}
				};

				scope.formatTimestamp = function(timestamp) {
					var date = new Date(timestamp);
					return date.toLocaleTimeString('zh-CN', { hour12: false });
				};

				// 监听会话事件
				scope.$on('agent-session-event', function(_event, value) {
					if (!scope.agentControl || !scope.agentControl.session) return;
					if (value.executionId !== scope.agentControl.session.executionId) return;

					scope.sessionLog.visible = true;

					switch (value.type) {
						case 'session.delta':
							var payload = value.payload || {};
							var text = '';
							// item/agentMessage/delta
							if (payload.delta && payload.delta.text) {
								text = payload.delta.text;
							}
							// item/commandExecution/outputDelta
							else if (payload.outputDelta) {
								text = payload.outputDelta;
							}
							if (text) {
								appendDelta(text);
							}
							break;

						case 'session.tool.started':
							finalizeDelta();
							var tool = value.payload || {};
							addEntry('tool-started', '工具执行: ' + (tool.tool || tool.name || 'unknown'), {
								tool: tool.tool || tool.name,
								description: tool.description
							});
							break;

						case 'session.tool.completed':
							var toolResult = value.payload || {};
							addEntry('tool-completed', '工具完成: ' + (toolResult.tool || toolResult.name || 'unknown'), {
								tool: toolResult.tool || toolResult.name,
								status: toolResult.status || 'success'
							});
							break;

						case 'session.state.changed':
							finalizeDelta();
							var state = value.payload || {};
							if (state.status) {
								var statusText = agentSessionI18n.t('status_' + state.status) || state.status;
								addEntry('state-change', '状态: ' + statusText, { status: state.status });
							}
							break;

						case 'session.completed':
							finalizeDelta();
							addEntry('state-change', '会话完成', { status: 'completed' });
							scope.sessionLog.currentTurn = null;
							break;

						case 'session.input.required':
							finalizeDelta();
							var input = value.payload || {};
							addEntry('state-change', '等待审批: ' + (input.prompt || '需要用户输入'), {
								kind: input.kind,
								requestId: input.requestId
							});
							break;
					}

					// 触发Angular更新
					if (!scope.$$phase) {
						scope.$apply();
					}
				});

				// 监听会话快照（初始化时）
				scope.$on('agent-session-snapshot', function(_event, value) {
					if (value && value.session) {
						scope.sessionLog.currentTurn = value.session.activeTurnId;
						if (value.session.status === 'running') {
							scope.sessionLog.visible = true;
						}
					}
				});

				// 清理
				scope.$on('$destroy', function() {
					if (deltaTimeoutId) {
						clearTimeout(deltaTimeoutId);
					}
				});
			}
		};
	}
]);
