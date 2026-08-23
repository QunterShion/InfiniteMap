angular.module('kityminderEditor').factory('agentSessionService', [
	    '$rootScope',
	    '$q',
		'agentSessionI18n',
	    function($rootScope, $q, agentSessionI18n) {
        var protocolVersion = 1;
        var sequence = 0;
        var pending = {};
        var liveSessionDetails = {};
        var liveSessionOrder = [];
        // FE-P1-01：session.delta 高频推送时使用 requestAnimationFrame 节流，避免每条delta触发独立$digest
        var pendingDelta = null;
        var deltaRafScheduled = false;
			var snapshot = {
				providers: [],
				session: null,
				document: {},
				mcpConnection: { state: 'connecting', attempt: 0, retryable: true }
			};

			function copyLiveDetail(detail) {
				if (!detail) return null;
				return Object.assign({}, detail, {
					events: (detail.events || []).slice(),
					transcript: (detail.transcript || []).map(function(entry) { return Object.assign({}, entry); })
				});
			}

			function upsertTranscript(detail, entry) {
				if (!entry || !entry.id) return;
				detail.transcript = detail.transcript || [];
				var index = detail.transcript.findIndex(function(candidate) { return candidate.id === entry.id; });
				if (index >= 0) detail.transcript[index] = Object.assign({}, entry);
				else detail.transcript.push(Object.assign({}, entry));
			}

			function rememberLiveSnapshot(raw, nodeId) {
				var session = normalizeSession(raw);
				if (!session || !session.executionId) return null;
				var detail = liveSessionDetails[session.executionId] || {
					executionId: session.executionId,
					events: [],
					transcript: []
				};
				detail.status = session.status || detail.status;
				detail.session = session.session || detail.session;
				detail.sequence = session.sequence;
				detail.updatedAt = session.updatedAt || detail.updatedAt;
				detail.activeTurnId = session.activeTurnId;
				detail.requestedConfig = session.requestedConfig || detail.requestedConfig;
				detail.effectiveConfig = session.effectiveConfig || detail.effectiveConfig;
				detail.nodeId = nodeId || session.nodeId || detail.nodeId || null;
				detail.title = session.title || detail.title || null;
				(session.transcript || []).forEach(function(entry) { upsertTranscript(detail, entry); });
				if (!liveSessionDetails[session.executionId]) {
					liveSessionOrder.unshift(session.executionId);
				}
				liveSessionDetails[session.executionId] = detail;
				while (liveSessionOrder.length > 20) {
					delete liveSessionDetails[liveSessionOrder.pop()];
				}
				return detail;
			}

			function eventText(message) {
				var payload = message.payload || {};
				var error = eventError(payload);
				if (message.type === 'session.delta') {
					if (payload.delta && payload.delta.text) return payload.delta.text;
					return payload.outputDelta || '';
				}
				if (message.type === 'session.tool.started') {
					return '▶ ' + (payload.tool || payload.name || 'tool');
				}
				if (message.type === 'session.tool.completed') {
					return '✓ ' + (payload.tool || payload.name || 'tool');
				}
				if (message.type === 'session.input.required') {
					return payload.prompt || payload.description || 'Input required';
				}
				if (message.type === 'session.state.changed') {
					return error || payload.status || '';
				}
				if (message.type === 'session.completed') {
					return error || payload.status || payload.turn && payload.turn.status || 'completed';
				}
				return '';
			}

			function eventError(payload) {
				var error = payload && (payload.error || payload.turn && payload.turn.error);
				if (!error) return '';
				if (typeof error === 'string') return error;
				return error.message || error.code || String(error);
			}

			function rememberLiveEvent(message) {
				if (!message.executionId) return null;
				var detail = liveSessionDetails[message.executionId] || rememberLiveSnapshot({
					executionId: message.executionId,
					status: 'running',
					updatedAt: new Date().toISOString(),
					sequence: message.sequence || 0
				});
				var payload = message.payload || {};
				detail.sequence = message.sequence || detail.sequence;
				detail.updatedAt = payload.updatedAt || new Date().toISOString();
				if (message.type === 'session.state.changed' && payload.status) {
					detail.status = payload.status;
					detail.activeTurnId = payload.activeTurnId;
				}
				if (message.type === 'session.completed') {
					var completedStatus = payload.status || payload.turn && payload.turn.status;
					detail.status = completedStatus === 'failed' || completedStatus === 'interrupted'
						? completedStatus
						: 'completed';
					detail.activeTurnId = null;
				}
				if (message.type === 'session.transcript.updated') {
					if (payload.entry) upsertTranscript(detail, payload.entry);
					(payload.transcript || []).forEach(function(entry) { upsertTranscript(detail, entry); });
				}
				var error = eventError(payload);
				if (error) {
					detail.error = {
						code: payload.error && payload.error.code || payload.turn && payload.turn.error && payload.turn.error.code || 'SESSION_FAILED',
						message: error
					};
				} else if (payload.status && payload.status !== 'failed' && payload.status !== 'disconnected' && payload.status !== 'conflict') {
					detail.error = null;
				}
				var text = eventText(message);
				if (text && message.type !== 'session.transcript.updated') {
					var last = detail.events[detail.events.length - 1];
					if (message.type === 'session.delta' && last && last.type === 'session.delta') {
						last.text += text;
						last.updatedAt = detail.updatedAt;
					} else {
						detail.events.push({
							id: message.sequence || (Date.now() + '-' + detail.events.length),
							type: message.type,
							text: text,
							updatedAt: detail.updatedAt
						});
					}
					if (detail.events.length > 200) detail.events.shift();
				}
				return detail;
			}

			function announceLiveDetail(detail) {
				if (!detail) return;
				$rootScope.$broadcast('agent-session-live-detail', copyLiveDetail(detail));
			}

			function normalizeError(error) {
				if (!error || error.code !== 'MCP_UNAVAILABLE') return error;
				return Object.assign({}, error, {
					message: agentSessionI18n.t('mcpOperationFailed')
				});
			}

        window.addEventListener('message', function(event) {
            var message = event.data || {};
            if (message.protocolVersion !== protocolVersion) return;
            if (message.command === 'agentSessionResult') {
                var request = pending[message.requestId];
                if (!request) return;
                delete pending[message.requestId];
                if (message.ok) {
                    request.resolve(message.result);
                } else {
	                    request.reject(normalizeError(message.error) || { code: 'INTERNAL_ERROR', message: 'Unknown error' });
                }
                $rootScope.$evalAsync();
			} else if (message.command === 'agentSessionEvent') {
				var liveDetail = rememberLiveEvent(message);
				if (message.type === 'session.delta' || message.type === 'session.transcript.updated') {
                    // FE-P1-01：delta 高频到达时合并到下一帧，每帧仅触发一次$digest
                    pendingDelta = message;
                    if (!deltaRafScheduled) {
                        deltaRafScheduled = true;
                        window.requestAnimationFrame(function() {
                            deltaRafScheduled = false;
                            var delta = pendingDelta;
                            pendingDelta = null;
								if (delta) {
									$rootScope.$evalAsync(function() {
										$rootScope.$broadcast('agent-session-event', delta);
										announceLiveDetail(liveDetail);
									});
                            }
                        });
                    }
                } else {
					$rootScope.$evalAsync(function() {
						$rootScope.$broadcast('agent-session-event', message);
						announceLiveDetail(liveDetail);
					});
                }
				} else if (message.command === 'agentSessionSnapshot') {
					snapshot = {
						providers: message.providers || [],
						session: normalizeSession(message.session),
						document: message.document || {},
						mcpConnection: snapshot.mcpConnection
					};
					var snapshotDetail = rememberLiveSnapshot(message.session);
				$rootScope.$evalAsync(function() {
					$rootScope.$broadcast('agent-session-snapshot', snapshot);
					announceLiveDetail(snapshotDetail);
				});
				} else if (message.command === 'agentProviderInstallProgress') {
					$rootScope.$evalAsync(function() {
						$rootScope.$broadcast('agent-provider-install-progress', message);
					});
				} else if (message.command === 'mcpConnectionState') {
					snapshot.mcpConnection = {
						state: message.state || 'unavailable',
						attempt: message.attempt || 0,
						nextRetryMs: message.nextRetryMs,
						retryable: message.retryable !== false
					};
					$rootScope.$evalAsync(function() {
						$rootScope.$broadcast('mcp-connection-state', snapshot.mcpConnection);
					});
	            }
        });

        // 统一驼峰字段格式，兼容可能的下划线格式，确保 activeTurnId 等字段始终可访问
        function normalizeSession(raw) {
            if (!raw) return null;
            return {
                executionId:     raw.executionId    != null ? raw.executionId    : (raw.execution_id     || null),
                status:          raw.status         || null,
                session:         raw.session        || null,
                sequence:        raw.sequence       != null ? raw.sequence       : 0,
                updatedAt:       raw.updatedAt      || raw.updated_at            || null,
                activeTurnId:    raw.activeTurnId   != null ? raw.activeTurnId   : (raw.active_turn_id   != null ? raw.active_turn_id   : null),
				requestedConfig: raw.requestedConfig || raw.requested_config     || null,
				effectiveConfig: raw.effectiveConfig || raw.effective_config     || null,
				transcript:      raw.transcript      || [],
				degradations:    raw.degradations    || [],
				error:           raw.error          || null,
				nodeId:          raw.nodeId        || raw.node_id        || null,
				title:           raw.title         || null,
            };
        }

		function captureSessionResult(result, nodeId) {
			var detail = rememberLiveSnapshot(result && result.session, nodeId);
			$rootScope.$evalAsync(function() { announceLiveDetail(detail); });
			return result;
		}

        function request(operation, payload) {
            var deferred = $q.defer();
            var requestId = 'agent-session-' + Date.now().toString(36) + '-' + (++sequence).toString(36);
            if (!window.infiniteMapDocumentUri) {
                deferred.reject({ code: 'INTERNAL_ERROR', message: 'Document context is unavailable.' });
                return deferred.promise;
            }
            pending[requestId] = deferred;
            window.vscode.postMessage(Object.assign({
                command: 'agentSession',
                protocolVersion: protocolVersion,
                requestId: requestId,
                operation: operation,
                documentUri: window.infiniteMapDocumentUri
            }, payload || {}));
            return deferred.promise;
        }

        return {
            request: request,
            normalizeSession: normalizeSession,
			getSnapshot: function() {
				return snapshot;
			},
				discoverProviders: function() {
					return request('discoverProviders');
				},
				reconnectMcp: function() {
					return request('reconnectMcp');
				},
			installProvider: function(providerId) {
				return request('installProvider', { providerId: providerId });
			},
			authenticateProvider: function(providerId) {
				return request('authenticateProvider', { providerId: providerId });
			},
			listModels: function(providerId) {
				return request('listModels', { providerId: providerId });
			},
			send: function(payload) {
				return request('send', payload).then(function(result) {
					return captureSessionResult(result, payload && payload.nodeId);
				});
			},
			append: function(payload) {
				return request('append', payload).then(function(result) {
					return captureSessionResult(result, payload && payload.nodeId);
				});
			},
			interrupt: function(expectedTurnId) {
				return request('interrupt', { expectedTurnId: expectedTurnId }).then(function(result) {
					return captureSessionResult(result);
				});
			},
			querySession: function() {
				return request('querySession');
			},
			querySessionDetail: function(executionId, nodeId) {
				return request('querySessionDetail', { executionId: executionId, nodeId: nodeId });
			},
			resolveInput: function(requestId, decision, value) {
				return request('resolveInput', {
					inputRequestId: requestId,
					decision: decision,
					inputValue: value
				});
			},
            queryHistory: function(nodeId) {
                return request('queryHistory', { nodeId: nodeId });
            },
			queryHistoryPage: function(nodeId, cursor, limit) {
				return request('queryHistory', { nodeId: nodeId, cursor: cursor, limit: limit });
			},
			queryActivityPage: function(cursor, limit) {
				return request('queryHistory', { cursor: cursor, limit: limit || 100 });
			},
			listLiveAgentSessions: function() {
				return liveSessionOrder.map(function(executionId) {
					return copyLiveDetail(liveSessionDetails[executionId]);
				}).filter(Boolean);
			},
			getLiveSessionDetail: function(executionId) {
				return copyLiveDetail(liveSessionDetails[executionId]);
			},
            openSession: function(nodeId, executionId, target) {
				return request('openSession', { nodeId: nodeId, executionId: executionId, target: target });
            }
        };
    }
]);
