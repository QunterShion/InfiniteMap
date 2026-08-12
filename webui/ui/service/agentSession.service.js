angular.module('kityminderEditor').factory('agentSessionService', [
	    '$rootScope',
	    '$q',
		'agentSessionI18n',
	    function($rootScope, $q, agentSessionI18n) {
        var protocolVersion = 1;
        var sequence = 0;
        var pending = {};
        // FE-P1-01：session.delta 高频推送时使用 requestAnimationFrame 节流，避免每条delta触发独立$digest
        var pendingDelta = null;
        var deltaRafScheduled = false;
			var snapshot = {
				providers: [],
				session: null,
				document: {},
				mcpConnection: { state: 'connecting', attempt: 0, retryable: true }
			};

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
                if (message.type === 'session.delta') {
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
                                });
                            }
                        });
                    }
                } else {
                    $rootScope.$evalAsync(function() {
                        $rootScope.$broadcast('agent-session-event', message);
                    });
                }
				} else if (message.command === 'agentSessionSnapshot') {
					snapshot = {
						providers: message.providers || [],
						session: normalizeSession(message.session),
						document: message.document || {},
						mcpConnection: snapshot.mcpConnection
					};
				$rootScope.$evalAsync(function() {
					$rootScope.$broadcast('agent-session-snapshot', snapshot);
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
            };
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
				return request('send', payload);
			},
			append: function(payload) {
				return request('append', payload);
			},
			interrupt: function(expectedTurnId) {
				return request('interrupt', { expectedTurnId: expectedTurnId });
			},
			querySession: function() {
				return request('querySession');
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
            openSession: function(nodeId, executionId, target) {
				return request('openSession', { nodeId: nodeId, executionId: executionId, target: target });
            }
        };
    }
]);
