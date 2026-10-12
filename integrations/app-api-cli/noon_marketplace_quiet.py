"""Pure Main/Supermall quiet-delivery capability boundary for the decoded HBC.

Native option observations do not establish quiet semantics. In particular,
``note.content`` belongs to the alternate-recipient overlay, not a rider note.
The unsupported result is deliberate: no request or successful verification is
available until the missing native semantic binding is evidenced.
"""
from copy import deepcopy

from noon_marketplace_review import ReviewError, digest, require, text


HBC_SHA256 = 'a213ec477e181c8e4b9ccb4fa85b13a064559c8c4ad93c3869f1200d12f487f3'
EXPERIENCES = {'main': 'ecom', 'supermall': 'rocket'}
QUIET_REQUIREMENTS = ('leave_at_door', 'no_bell', 'no_call')
MISSING_NODES = (
    {
        'requirement': 'quiet_option_semantics',
        'native_node': 'session.deliveryOptions[code].message/action/type/status',
        'anchor': 'f88688@83,@98..132,@192..196,@539..555,@642',
        'missing': 'A returned option code and proven activation semantics for each quiet requirement.',
    },
    {
        'requirement': 'quiet_option_activation',
        'native_node': 'f88684 inactive info action -> parent environment slot 8 -> f119177 -> f88680',
        'anchor': 'f88684@16..102; f119177@0..19; f88680@128..160',
        'missing': 'Quiet-specific info-overlay content and the accepted active value for its server code.',
    },
    {
        'requirement': 'saved_address_quiet_preferences',
        'native_node': 'session.addressCode -> saved address.addressCode/addressKey',
        'anchor': 'f88612@18; f119106@3,@16; f84763@145,@185; f88582@224',
        'missing': 'A Main/Supermall saved-address quiet preference reader/writer linked to checkout.',
    },
    {
        'requirement': 'rider_note',
        'native_node': 'deliveryOptions[code].note.content -> AlternatePhoneScreen.noteContent',
        'anchor': 'f88683@50..74,@135; f88681@76',
        'missing': 'A Main/Supermall rider-note request field and accepted-state binding; this node is UI copy.',
    },
)


class QuietDeliveryUnsupported(ReviewError):
    def __init__(self, contract):
        super().__init__('UNSUPPORTED_NATIVE_MARKETPLACE_QUIET_DELIVERY')
        self.contract = deepcopy(contract)


def native_delivery_options(session):
    """Parse only session.deliveryOptions, retaining absence and native statuses.

    ``None`` means the response omitted the option map, not an empty inventory.
    Unknown statuses remain observable, never silently treated as selectable.
    No labels, map keys, alternate phone fields or note copy become quiet flags.
    """
    require(type(session) is dict, 'SCHEMA_MARKETPLACE_SESSION')
    if 'deliveryOptions' not in session:
        return None
    options = session['deliveryOptions']
    require(type(options) is dict and len(options) <= 1000, 'SCHEMA_DELIVERY_OPTIONS')
    out = []
    for code, option in options.items():
        require(type(code) is str, 'INVALID_DELIVERY_OPTION_CODE')
        text(code, 'INVALID_DELIVERY_OPTION_CODE')
        require(type(option) is dict, 'SCHEMA_DELIVERY_OPTION')
        status = option.get('status')
        require(type(status) is str, 'INVALID_DELIVERY_OPTION_STATUS')
        text(status, 'INVALID_DELIVERY_OPTION_STATUS')
        row = {'code': code, 'status': status,
               'active': status == 'active', 'disabled': status == 'disabled',
               'source_path': ('deliveryOptions', code), 'source_hash': digest(option)}
        for key in ('action', 'type', 'message'):
            if key in option:
                require(option[key] is None or type(option[key]) is str,
                        'INVALID_DELIVERY_OPTION_' + key.upper())
                row[key] = deepcopy(option[key])
        # f88684: already-active options deactivate; inactive info opens a
        # confirmation overlay, receiver_phone opens recipient UI, else no-op.
        if row['disabled']:
            row['native_press_branch'] = 'disabled'
        elif row['active']:
            row['native_press_branch'] = 'set_active_false'
        elif row.get('action') == 'info':
            row['native_press_branch'] = 'info_overlay'
        elif row.get('action') == 'receiver_phone':
            row['native_press_branch'] = 'alternate_receiver_phone'
        else:
            row['native_press_branch'] = 'no_activation'
        out.append(row)
    return out


def native_quiet_contract(session, *, service, request_experience, request_mp):
    """Describe the explicit unsupported native quiet branch without I/O.

    service is ``main`` or ``supermall``. request_experience/request_mp are
    caller-owned acquisition context from the actual request headers, not
    invented response echoes. They must be ecom/noon or rocket/noon respectively.
    This validates their consistency, not their freshness or authenticity.
    """
    require(type(service) is str and service in EXPERIENCES,
            'UNSUPPORTED_MARKETPLACE_SERVICE')
    require(request_experience == EXPERIENCES[service] and request_mp == 'noon',
            'MARKETPLACE_REQUEST_CONTEXT_MISMATCH')
    options = native_delivery_options(session)
    context = {'service': service, 'x-experience': request_experience, 'X-Mp': request_mp}
    binding = {'request_context': context, 'session_hash': digest(session)}
    return {
        'supported': False,
        'code': 'UNSUPPORTED_NATIVE_MARKETPLACE_QUIET_DELIVERY',
        'evidence_id': 'HBC:' + HBC_SHA256 + ':marketplace-quiet-v1',
        'request_context': context,
        'session_hash': binding['session_hash'],
        'binding_hash': digest(binding),
        'required_quiet_semantics': QUIET_REQUIREMENTS,
        'delivery_options': options,
        'missing_nodes': deepcopy(MISSING_NODES),
    }


def select_native_quiet_delivery(session, *, service, request_experience, request_mp):
    """Fail explicitly; no speculative option mutation or note payload is returned."""
    raise QuietDeliveryUnsupported(native_quiet_contract(
        session, service=service, request_experience=request_experience, request_mp=request_mp))


def verify_native_quiet_delivery(session, *, service, request_experience, request_mp):
    """Active controls or transport success cannot verify the three quiet semantics."""
    raise QuietDeliveryUnsupported(native_quiet_contract(
        session, service=service, request_experience=request_experience, request_mp=request_mp))
