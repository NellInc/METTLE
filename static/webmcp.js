// METTLE WebMCP — AI Agent Tool Discovery
// Chrome 145+ experimental API. Websites register tools via navigator.modelContext.registerTool()
// that AI agents discover and call directly. Progressive enhancement — no-op on unsupported browsers.

(function() {
  'use strict';

  if (typeof navigator === 'undefined' || !navigator.modelContext || typeof navigator.modelContext.registerTool !== 'function') {
    return;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function textResult(text) {
    return { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] };
  }

  function errorResult(message) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
  }

  async function postJSON(path, body) {
    var response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      var errBody;
      try { errBody = await response.json(); } catch (_) { errBody = { detail: response.statusText }; }
      throw new Error(errBody.detail || errBody.error || ('HTTP ' + response.status));
    }
    return response.json();
  }

  async function getJSON(path) {
    var response = await fetch(path);
    if (!response.ok) {
      var errBody;
      try { errBody = await response.json(); } catch (_) { errBody = { detail: response.statusText }; }
      throw new Error(errBody.detail || errBody.error || ('HTTP ' + response.status));
    }
    return response.json();
  }

  /**
   * Strip any fields from a challenge object that could leak expected answers.
   */
  function sanitizeChallenge(challenge) {
    if (!challenge || typeof challenge !== 'object') return challenge;
    var clean = {};
    var blocked = ['expected_answer', 'answer', 'correct_answer', 'solution', 'expected'];
    for (var key in challenge) {
      if (challenge.hasOwnProperty(key) && blocked.indexOf(key) === -1) {
        clean[key] = challenge[key];
      }
    }
    return clean;
  }

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------

  var tools = [
    // Tool 1: Start verification session
    {
      name: 'mettle_start_verification',
      description: 'Start a new METTLE verification session. Returns the first challenge to answer.',
      inputSchema: {
        type: 'object',
        properties: {
          difficulty: {
            type: 'string',
            enum: ['basic', 'full'],
            description: 'basic = 3 challenges, full = 5'
          },
          entity_id: {
            type: 'string',
            description: 'Optional identifier for the entity being verified'
          }
        },
        required: ['difficulty']
      },
      annotations: { readOnlyHint: false },
      execute: async function(params) {
        if (!params || !params.difficulty) {
          return errorResult('difficulty is required (basic or full)');
        }
        if (params.difficulty !== 'basic' && params.difficulty !== 'full') {
          return errorResult('difficulty must be "basic" or "full"');
        }

        try {
          var body = { difficulty: params.difficulty };
          if (params.entity_id) {
            body.entity_id = params.entity_id;
          }

          var data = await postJSON('/api/session/start', body);

          var result = {
            session_id: data.session_id,
            total_challenges: data.total_challenges
          };

          if (data.current_challenge) {
            result.current_challenge = sanitizeChallenge(data.current_challenge);
          }

          return textResult(result);
        } catch (err) {
          return errorResult('Failed to start session: ' + err.message);
        }
      }
    },

    // Tool 2: Answer a challenge
    {
      name: 'mettle_answer_challenge',
      description: 'Submit an answer to the current METTLE challenge. Returns result and next challenge if any.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'The session ID from mettle_start_verification'
          },
          challenge_id: {
            type: 'string',
            description: 'The challenge ID to answer'
          },
          answer: {
            type: 'string',
            description: 'Your answer to the challenge'
          }
        },
        required: ['session_id', 'challenge_id', 'answer']
      },
      annotations: { readOnlyHint: false },
      execute: async function(params) {
        if (!params || !params.session_id) {
          return errorResult('session_id is required');
        }
        if (!params.challenge_id) {
          return errorResult('challenge_id is required');
        }
        if (typeof params.answer === 'undefined' || params.answer === null) {
          return errorResult('answer is required');
        }

        try {
          var data = await postJSON('/api/session/answer', {
            session_id: params.session_id,
            challenge_id: params.challenge_id,
            answer: String(params.answer)
          });

          var result = {};

          if (data.result) {
            result.result = {
              passed: data.result.passed,
              response_time_ms: data.result.response_time_ms
            };
            if (data.result.reason) {
              result.result.reason = data.result.reason;
            }
          }

          if (data.next_challenge) {
            result.next_challenge = sanitizeChallenge(data.next_challenge);
          }

          if (typeof data.challenges_remaining !== 'undefined') {
            result.challenges_remaining = data.challenges_remaining;
          }

          if (typeof data.session_complete !== 'undefined') {
            result.session_complete = data.session_complete;
          }

          return textResult(result);
        } catch (err) {
          return errorResult('Failed to submit answer: ' + err.message);
        }
      }
    },

    // Tool 3: Get session result
    {
      name: 'mettle_get_result',
      description: 'Get the final verification result for a completed METTLE session. Returns pass/fail status and badge if verified.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'The session ID to get results for'
          }
        },
        required: ['session_id']
      },
      annotations: { readOnlyHint: true },
      execute: async function(params) {
        if (!params || !params.session_id) {
          return errorResult('session_id is required');
        }

        try {
          var data = await getJSON('/api/session/' + encodeURIComponent(params.session_id) + '/result');

          var result = {
            verified: !!data.verified,
            pass_rate: data.pass_rate
          };

          if (data.badge_token) {
            result.badge_token = data.badge_token;
          }
          if (data.badge) {
            result.badge_token = data.badge;
          }

          return textResult(result);
        } catch (err) {
          return errorResult('Failed to get result: ' + err.message);
        }
      }
    },

    // Tool 4: Verify a badge
    {
      name: 'mettle_verify_badge',
      description: 'Verify an existing METTLE badge token. Returns whether the badge is valid, who it was issued to, and when it expires.',
      inputSchema: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            description: 'The badge token (JWT) to verify'
          }
        },
        required: ['token']
      },
      annotations: { readOnlyHint: true },
      execute: async function(params) {
        if (!params || !params.token) {
          return errorResult('token is required');
        }

        try {
          var data = await getJSON('/api/badge/verify/' + encodeURIComponent(params.token));

          var result = {
            valid: !!data.valid
          };

          if (data.entity_id) {
            result.entity_id = data.entity_id;
          }
          if (data.issued_at) {
            result.issued_at = data.issued_at;
          }
          if (data.expires_at) {
            result.expires_at = data.expires_at;
          }
          if (data.verified_at) {
            result.issued_at = result.issued_at || data.verified_at;
          }
          if (data.exp) {
            result.expires_at = result.expires_at || new Date(data.exp * 1000).toISOString();
          }
          if (data.reason) {
            result.reason = data.reason;
          }

          return textResult(result);
        } catch (err) {
          return errorResult('Failed to verify badge: ' + err.message);
        }
      }
    }
  ];

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  var registrations = [];

  for (var i = 0; i < tools.length; i++) {
    try {
      registrations.push(navigator.modelContext.registerTool(tools[i]));
      console.log('[WebMCP] Registered: ' + tools[i].name);
    } catch (e) {
      console.warn('[WebMCP] Failed: ' + tools[i].name, e);
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup on page unload
  // ---------------------------------------------------------------------------

  window.addEventListener('beforeunload', function() {
    for (var j = 0; j < registrations.length; j++) {
      try {
        if (registrations[j] && typeof registrations[j].unregister === 'function') {
          registrations[j].unregister();
        }
      } catch (_) {
        // Ignore cleanup errors during page unload
      }
    }
  });
})();
