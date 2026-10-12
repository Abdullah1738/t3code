"""No-send composition of local checkout contracts. Live submission is disabled.

No auth, HTTP transport, journal consumption, fresh-quote launcher, payment SDK,
or owner-interaction channel is connected here. Every input is supplied evidence;
a rehearsal does not prove those requests happened or that responses are related.
"""
import json

import talabat_fresh_review as review
import talabat_payment_outcome as outcome
import talabat_payment_route as route


def prepare_review(snapshot, *, observed_at, now, started_monotonic, now_monotonic, ttl=120):
    """Validate both the ordinary place draft and the selected payment candidate.

    Capture the supplied clock pair BEFORE the oldest observation. The resulting
    review hashes the full payment config, so event/platform/precheck drift changes
    approval binding. This does not establish effective controller/fallback state.
    """
    data = json.loads(review._json(snapshot))
    frozen = review.build_review(data, observed_at=observed_at, now=now,
                                 started_monotonic=started_monotonic,
                                 now_monotonic=now_monotonic, ttl=ttl)
    home = review.q.c.select_home(data['addresses'], {'expected_profile':data['expected_profile']})
    card = review.q.c.select_card(data['cards'])
    vendor = review.q.c.select_vendor(data['vendor'])
    route.selected_payment_event(home=home, vendor=vendor, config=data['payment_config'], saved_card=card)
    return frozen


def rehearse(original, acknowledgement, current_snapshot, *, observed_at, started_monotonic,
             now, now_monotonic, place_status=None, place_response=None,
             payment_status=None, payment_response=None, tracking_response=None):
    """Full local preflight and conservative supplied-result interpretation.

    Never consumes even a local journal. Tests separately compose the permanent
    fence in an isolated directory. Never call this to decide that a real payment
    succeeded: status has no amount/card/identity echo and no transport is bound.
    """
    current = prepare_review(current_snapshot, observed_at=observed_at, now=now,
                             started_monotonic=started_monotonic, now_monotonic=now_monotonic)
    approval = review.check_approval_binding(original, current, acknowledgement,
                                             now=now, now_monotonic=now_monotonic)
    placed = review.place.parse_response(place_status, place_response)
    return {
        'mode':'NO_SEND_REHEARSAL',
        'review':review.project_review(current, now=now, now_monotonic=now_monotonic),
        'approval':approval,
        'selected_payment_candidate_validated':True,
        'effective_native_route_verified':False,
        'place_observation':review.place.project_response(placed),
        'payment_observation':outcome.project_payment_status(payment_status, payment_response),
        'order_observation':outcome.project_order_readback(placed, tracking_response),
        'supplied_result_transport_binding_verified':False,
        'server_precharge_amount_binding_verified':False,
        'request_id_idempotency_verified':False,
        'owner_authorization_verified':False,
        'fresh_server_provenance_verified':False,
        'payment_completion_verified':False,
        'journal_consumed':False,
        'request_sent':False,
        'retry_allowed':False,
        'ready_to_order':False,
        'commit_enabled':False,
    }


def submit(*args, **kwargs):
    """Unconditional pre-IO stop; no caller flags/digests can turn this into a send."""
    review.q.c._fail('ORDER_ADAPTER_DISABLED_PRECHARGE_BINDING_AND_TRUSTED_LIVE_FLOW_UNPROVEN')
