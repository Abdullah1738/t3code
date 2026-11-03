"""mailsend against a fake himalaya and a fake send-approval. Nothing is sent."""
import json
import os
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "helpers", "mailsend")

# Builds the MIME the way himalaya compose/reply/forward print it; logs every call.
FAKE_HIMALAYA = r'''
import json, os, sys, time
from email.message import EmailMessage
argv = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as fh:
    fh.write(json.dumps(argv) + "\n")
acct = argv[argv.index("-a") + 1]
verb = argv[argv.index("message") + 1]
if verb == "send":
    if os.environ.get("FAKE_SEND_SLEEP"):
        time.sleep(float(os.environ["FAKE_SEND_SLEEP"]))
    rc = int(os.environ.get("FAKE_SEND_RC") or 0)
    if rc:
        print("smtp error: 554 rejected", file=sys.stderr)
    sys.exit(rc)
if verb == "add":
    sys.exit(int(os.environ.get("FAKE_ADD_RC") or 0))
def opt(name):
    return [a.split("=", 1)[1] for a in argv if a.startswith(name + "=")]
m = EmailMessage()
m["From"] = '"Abdullah Rangoonwala" <%s@example.com>' % acct
to = opt("--to")
if verb == "reply":
    to = ["orig@example.com"] + to
if to:
    m["To"] = ", ".join("<%s>" % t for t in to)
if opt("--cc"):
    m["Cc"] = ", ".join("<%s>" % t for t in opt("--cc"))
if os.environ.get("FAKE_BCC"):
    m["Bcc"] = "<hidden@example.com>"
m["Subject"] = {"compose": (opt("--subject") or [""])[0], "reply": "Re: Hi", "forward": "Fwd: Hi"}[verb]
body = (opt("--body") or [""])[0]
if verb in ("reply", "forward"):
    # himalaya quotes the source message and adds the account signature.
    body += "\n\n> the original secret line\n-- \nAbdullah's signature"
m.set_content(body)
if os.environ.get("FAKE_HTML"):
    m.add_alternative("<p>%s</p>" % body, subtype="html")
for p in opt("--attach"):
    if os.environ.get("FAKE_DROP_ATTACH"):
        continue
    with open(p, "rb") as fh:
        m.add_attachment(fh.read(), maintype="application", subtype="octet-stream", filename=os.path.basename(p))
sys.stdout.buffer.write(bytes(m))
'''

FAKE_APPROVAL = """#!/usr/bin/python3
import json, os, sys, time
if sys.argv[1] == "visible":
    sys.exit("Refused: hidden text" if "<think" in sys.argv[2] else 0)
with open(os.environ["FAKE_APPROVALS"], "a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\\n")
time.sleep(float(os.environ.get("SA_SLEEP") or 0))
if os.environ.get("SA_REFUSE"):
    sys.exit("Refused: not shown")
print("approved: ok")
"""


def read_json(path):
    with open(path) as fh:
        return json.load(fh)


class MailsendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.drafts = os.path.join(t, "drafts")
        self.log = os.path.join(t, "himalaya.log")
        self.approvals = os.path.join(t, "approvals.log")
        fake = os.path.join(t, "fake_himalaya.py")
        with open(fake, "w") as fh:
            fh.write(FAKE_HIMALAYA)
        sa = os.path.join(t, "send-approval")
        with open(sa, "w") as fh:
            fh.write(FAKE_APPROVAL)
        os.chmod(sa, 0o755)
        self.file = os.path.join(t, "menu.pdf")
        with open(self.file, "wb") as fh:
            fh.write(b"%PDF fake")
        self.env = {"HOME": t, "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "ROBOB_TEST": "1", "MAILSEND_DRAFT_DIR": self.drafts,
                    "MAILSEND_HIMALAYA": f"/usr/bin/python3 {fake}", "MAILSEND_SEND_APPROVAL": sa,
                    "FAKE_LOG": self.log, "FAKE_APPROVALS": self.approvals}

    def tearDown(self):
        self.tmp.cleanup()

    def ms(self, *args, **extra):
        r = subprocess.run(["/usr/bin/python3", HELPER, *args], env={**self.env, **extra}, capture_output=True,
                           text=True, timeout=60)
        return r.returncode, r.stdout, r.stderr

    def calls(self, verb=None):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as fh:
            rows = [json.loads(l) for l in fh if l.strip()]
        return [r for r in rows if verb is None or r[r.index("message") + 1] == verb]

    def approval_calls(self):
        if not os.path.exists(self.approvals):
            return []
        with open(self.approvals) as fh:
            return [json.loads(l) for l in fh if l.strip()]

    def draft(self, *extra, body="Can we move it to Friday?"):
        code, out, err = self.ms("draft", "-a", "icloud", "-t", "host@example.com", "-s", "Booking",
                                 "--body", body, *extra)
        self.assertEqual(code, 0, err)
        return out.split()[1], out

    def state(self, i):
        return sorted(f for f in os.listdir(self.drafts) if f.startswith(i))

    def test_draft_prints_the_preview_and_sends_nothing(self):
        i, out = self.draft("--cc", "moni@example.com", "--attach", self.file)
        self.assertRegex(i, r"^[0-9a-f]{10}$")
        d = read_json(os.path.join(self.drafts, f"{i}.json"))
        self.assertEqual(d["preview"], "Email from icloud@example.com (icloud)\nTo: host@example.com\n"
                         f"Cc: moni@example.com\nSubject: Booking\nAttachment: {self.file} (sha256 "
                         f"{d['attachments'][0]['sha256'][:12]})\n\nCan we move it to Friday?\n(draft {i})")
        self.assertIn(d["preview"], out)
        self.assertIn(f"Send: mailsend send --approved {i}", out)
        self.assertIn("Tip: when a message speaks for Abdullah", out)
        self.assertEqual(self.calls("send"), [])
        compose = self.calls("compose")[0]
        self.assertNotIn("--send", compose)
        self.assertNotIn("--save", " ".join(compose))
        self.assertEqual((d["from"], d["to"], d["cc"], d["subject"]),
                         ("icloud@example.com", ["host@example.com"], ["moni@example.com"], "Booking"))
        self.assertEqual(len(d["attachments"]), 1)

    def test_approved_alone_sends_once_and_runs_no_check(self):
        i, _ = self.draft()
        code, out, err = self.ms("send", "--approved", i)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.approval_calls(), [])
        self.assertEqual(len(self.calls("send")), 1)
        self.assertEqual(self.ms("send", "--approved", i)[0], 2)
        self.assertEqual(len(self.calls("send")), 1)

    def test_approved_send_goes_once_and_binds_every_field(self):
        i, _ = self.draft("--cc", "moni@example.com", "--attach", self.file)
        code, out, err = self.ms("send", "--approved", i, "--inbound", "6E3E6964-AAAA")
        self.assertEqual(code, 0, err)
        self.assertIn("(sent) Email to host@example.com, moni@example.com: Booking", out)
        self.assertEqual(self.approval_calls(), [])
        d = read_json(os.path.join(self.drafts, f"{i}.sent.json"))
        sends = self.calls("send")
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0][-1], os.path.join(self.drafts, f"{i}.eml"))
        self.assertEqual(self.calls("add")[0][:7], ["-a", "icloud", "message", "add", "-m", "sent", "-f"])
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.sent.json"])
        code, _, err = self.ms("send", "--approved", i, "--inbound", "6E3E6964-AAAA")
        self.assertEqual(code, 2)
        self.assertIn("already used", err)
        self.assertEqual(len(self.calls("send")), 1)
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "host@example.com", "-s", "Booking",
                               "--body", "Can we move it to Friday?", "--cc", "moni@example.com",
                               "--attach", self.file)
        self.assertEqual(code, 2)
        self.assertIn("already sent", err)

    def test_google_accounts_get_no_extra_sent_copy(self):
        code, out, err = self.ms("draft", "-a", "fund", "-t", "host@example.com", "-s", "Hi", "--body", "Hello")
        i = out.split()[1]
        self.assertEqual(self.ms("send", "--approved", i, "--app")[0], 0)
        self.assertEqual(self.approval_calls(), [])
        self.assertEqual(len(self.calls("send")), 1)
        self.assertEqual(self.calls("add"), [])

    def test_refusing_send_approval_does_not_stop_the_send(self):
        i, _ = self.draft()
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1", SA_REFUSE="1")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.approval_calls(), [])
        self.assertEqual(len(self.calls("send")), 1)
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.sent.json"])

    def test_a_revision_is_a_new_draft(self):
        a, _ = self.draft(body="Can we do EUR 3500?")
        b, _ = self.draft(body="Can we do EUR 3400?")
        self.assertNotEqual(a, b)

    def test_changed_attachment_or_stored_message_is_refused(self):
        i, _ = self.draft("--attach", self.file)
        with open(self.file, "ab") as fh:
            fh.write(b"edited")
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1")
        self.assertEqual(code, 2)
        self.assertIn("changed or is gone", err)
        j, _ = self.draft(body="other text")
        with open(os.path.join(self.drafts, f"{j}.eml"), "ab") as fh:
            fh.write(b"\nBcc: sneaky@example.com\n")
        code, _, err = self.ms("send", "--approved", j, "--inbound", "X1")
        self.assertEqual(code, 2)
        self.assertIn("changed", err)
        self.assertEqual(self.approval_calls(), [])
        self.assertEqual(self.calls("send"), [])

    def test_expired_and_unknown_drafts_are_refused(self):
        i, _ = self.draft()
        p = os.path.join(self.drafts, f"{i}.json")
        d = read_json(p)
        d["created_at"] = int(time.time()) - 2 * 86400
        with open(p, "w") as fh:
            json.dump(d, fh)
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1")
        self.assertEqual(code, 2)
        self.assertIn("older than 24h", err)
        code, _, err = self.ms("send", "--approved", "0123456789", "--inbound", "X1")
        self.assertEqual(code, 2)
        self.assertIn("no draft", err)
        self.assertEqual(self.calls("send"), [])

    def test_no_bcc_and_plain_addresses_only(self):
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "a@example.com", "--bcc", "b@example.com", "-s", "x",
                               "--body", "y")
        self.assertEqual(code, 2)
        self.assertIn("no Bcc", err)
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "Bee <b@example.com>", "-s", "x", "--body", "y")
        self.assertEqual(code, 2)
        self.assertIn("plain address", err)
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "a@example.com", "-s", "x", "--body", "y",
                               FAKE_BCC="1")
        self.assertEqual(code, 2)
        self.assertIn("Bcc header", err)
        self.assertFalse(os.path.exists(self.drafts) and os.listdir(self.drafts))

    def test_text_the_chat_would_hide_is_refused_at_draft_time(self):
        # Sol r2: the bridge strips internal and DCP text, so a preview with any isn't what he reads.
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "a@example.com", "-s", "x",
                               "--body", "Price is EUR 400 <think>say 500</think>")
        self.assertEqual(code, 2)
        self.assertIn("hidden text", err)
        self.assertFalse(os.path.exists(self.drafts) and [f for f in os.listdir(self.drafts) if f.endswith(".json")])

    def test_dropped_attachment_is_caught_at_draft_time(self):
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "a@example.com", "-s", "x", "--body", "y",
                               "--attach", self.file, FAKE_DROP_ATTACH="1")
        self.assertEqual(code, 1)
        self.assertIn("attachments don't match", err)

    def test_reply_and_forward_build_from_the_source_message(self):
        code, out, err = self.ms("reply", "-a", "gmail", "-m", "Inbox", "262282", "--body", "Thanks!")
        self.assertEqual(code, 0, err)
        self.assertIn("To: orig@example.com\nSubject: Re: Hi", out)
        # The preview is the whole text that goes out, quoted original and signature included.
        self.assertIn("Thanks!\n\n> the original secret line\n-- \nAbdullah's signature\n(draft ", out)
        r = self.calls("reply")[0]
        self.assertEqual(r[-2:], ["--", "262282"])
        self.assertIn("-m", r)
        code, out, err = self.ms("forward", "-a", "gmail", "-m", "Inbox", "262282", "-t", "b@example.com")
        self.assertEqual(code, 0, err)
        self.assertIn("To: b@example.com\nSubject: Fwd: Hi", out)

    def test_failed_send_is_settled_and_not_retried(self):
        i, _ = self.draft()
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1", FAKE_SEND_RC="1")
        self.assertEqual(code, 1)
        self.assertIn("554", err)
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.failed.json"])
        self.assertEqual(self.ms("send", "--approved", i, "--inbound", "X1")[0], 2)
        self.assertEqual(len(self.calls("send")), 1)
        # Writing it again gives a new id and preview, so the old OK can't send it.
        j, out = self.draft()
        self.assertNotEqual(i, j)
        self.assertIn(f"(draft {j})", out)

    def test_only_plain_text_mail(self):
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "a@example.com", "-s", "x", "--body", "y",
                               FAKE_HTML="1")
        self.assertEqual(code, 1)
        self.assertIn("plain text only", err)

    def test_a_pending_draft_is_never_rebuilt(self):
        i, _ = self.draft()
        eml = os.path.join(self.drafts, f"{i}.eml")
        with open(eml, "rb") as fh:
            before = fh.read()
        j, out = self.draft()
        self.assertEqual(i, j)
        with open(eml, "rb") as fh:
            self.assertEqual(fh.read(), before)

    def test_an_expired_draft_built_again_gets_a_new_id(self):
        # Astra r1 B5: a redraft of an expired WhatsApp draft renewed its clock under the same id; same for mail.
        i, _ = self.draft()
        p = os.path.join(self.drafts, f"{i}.json")
        d = read_json(p)
        d["created_at"] = int(time.time()) - 3 * 86400
        with open(p, "w") as fh:
            json.dump(d, fh)
        j, out = self.draft()
        self.assertNotEqual(i, j)
        self.assertIn(f"(draft {j})", out)
        self.assertTrue(os.path.exists(os.path.join(self.drafts, f"{i}.expired.json")))
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1")
        self.assertEqual(code, 2)
        self.assertIn("already used (expired)", err)
        self.assertEqual(self.approval_calls(), [])
        # A fresh pending draft keeps its clock when built again.
        pj = os.path.join(self.drafts, f"{j}.json")
        d = read_json(pj)
        d["created_at"] -= 3600
        with open(pj, "w") as fh:
            json.dump(d, fh)
        k, _ = self.draft()
        self.assertEqual(k, j)
        self.assertEqual(read_json(pj)["created_at"], d["created_at"])

    def test_an_id_retired_while_waiting_for_its_lock_is_not_reused(self):
        # Astra r2 S1: the failed/expired check ran before the lock, so a builder waiting on it published the id
        # another process had just retired, and its send was refused as already used.
        import fcntl
        i, _ = self.draft()
        for f in (f"{i}.json", f"{i}.eml"):
            os.remove(os.path.join(self.drafts, f))
        with open(os.path.join(self.drafts, "locks", i), "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            b = subprocess.Popen(["/usr/bin/python3", HELPER, "draft", "-a", "icloud", "-t", "host@example.com", "-s",
                                  "Booking", "--body", "Can we move it to Friday?"], env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(3)  # b is past its first check and waiting for the lock
            with open(os.path.join(self.drafts, f"{i}.failed.json"), "w") as fh:
                fh.write("{}")
        out, err = b.communicate(timeout=60)
        self.assertEqual(b.returncode, 0, err)
        j = out.split()[1]
        self.assertNotEqual(j, i)
        self.assertFalse(os.path.exists(os.path.join(self.drafts, f"{i}.json")))

    def test_two_senders_at_once_send_once(self):
        # Sol r1: a second sender could rename over the claim and send again.
        i, _ = self.draft()
        cmd = ["/usr/bin/python3", HELPER, "send", "--approved", i, "--inbound", "X1"]
        env = {**self.env, "SA_SLEEP": "1"}
        procs = [subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(3)]
        codes = sorted(p.communicate(timeout=60) and p.returncode for p in procs)
        self.assertEqual(codes, [0, 2, 2])
        self.assertEqual(len(self.calls("send")), 1)
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.sent.json"])

    def test_timed_out_send_is_uncertain_and_blocks_a_redraft(self):
        i, _ = self.draft()
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1", FAKE_SEND_SLEEP="5",
                               MAILSEND_SEND_TIMEOUT="1")
        self.assertEqual(code, 1)
        self.assertIn("may or may not have gone out", err)
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.uncertain.json"])
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "host@example.com", "-s", "Booking",
                               "--body", "Can we move it to Friday?")
        self.assertEqual(code, 2)
        self.assertIn("already sent or attempted", err)

    def card_env(self, **extra):
        # A stub renderer: writes the HTML it was given next to the PNG path, so the test can read what was drawn.
        stub = os.path.join(self.tmp.name, "stub_render.py")
        with open(stub, "w") as fh:
            fh.write("import shutil, sys\nhtml, out, w, h = sys.argv[1:5]\n"
                     "shutil.copy(html, out + '.html')\nopen(out + '.h', 'w').write(h)\n"
                     "open(out, 'wb').write(b'\\x89PNG fake')\n")
        return {"MAILSEND_CARD_RENDERER": f"/usr/bin/python3 {stub}", **extra}

    def card_html_of(self, out):
        with open(out + ".html") as fh:
            return fh.read()

    def card_h_of(self, out):
        with open(out + ".h") as fh:
            return int(fh.read())

    def test_card_height_grows_with_every_attachment_chip_row(self):
        # Review r1 P2: four or eight long attachment names wrap to several chip rows; the frame must grow with them.
        files = [os.path.join(self.tmp.name, f"Final-dinner-menu-option-{k}.pdf") for k in range(1, 9)]
        for p in files:
            with open(p, "wb") as fh:
                fh.write(b"%PDF fake")
        h = {}
        for n in (0, 1, 4, 8):
            i, _ = self.draft(*sum((["--attach", p] for p in files[:n]), []), body="Short body.")
            code, out, err = self.ms("card", i, **self.card_env())
            self.assertEqual(code, 0, err)
            h[n] = self.card_h_of(out.strip())
            self.assertIn(f"draft {i}", self.card_html_of(out.strip()))
        self.assertLess(h[0], h[1])
        self.assertLess(h[1], h[4])
        self.assertLess(h[4], h[8])

    def test_card_keeps_every_authored_line_visible(self):
        # Review r1 P2: a '>' line the writer typed is body text, not a quoted original; it must stay on the card.
        i, _ = self.draft(body="Deal is set.\n> We will pay EUR 3,400 on Friday.\nSee you then.")
        code, out, err = self.ms("card", i, **self.card_env())
        self.assertEqual(code, 0, err)
        page = self.card_html_of(out.strip())
        self.assertIn("&gt;", page)
        self.assertIn("We will pay EUR 3,400", page)
        self.assertIn("See you then.", page)
        self.assertNotIn("quoted original", page)

    def test_card_folds_only_the_source_quote_of_a_reply(self):
        code, out, err = self.ms("reply", "-a", "gmail", "-m", "Inbox", "262282",
                                 "--body", "We agree.\n> We will pay EUR 3,400 on Friday.")
        self.assertEqual(code, 0, err)
        i = out.split()[1]
        code, out, err = self.ms("card", i, **self.card_env())
        self.assertEqual(code, 0, err)
        page = self.card_html_of(out.strip())
        self.assertIn("&gt;", page)
        self.assertIn("We will pay EUR 3,400", page)
        self.assertIn("+ quoted original, 1 line", page)
        self.assertNotIn("the original secret line", page)

    def test_forward_with_no_body_folds_the_source_quote(self):
        # Review r2 P2: a forward with no added body has body "", and its whole text used to count as authored text,
        # so the quote never folded and a long source made several cards.
        code, out, err = self.ms("forward", "-a", "gmail", "-m", "Inbox", "262282", "-t", "host@example.com")
        self.assertEqual(code, 0, err)
        i = out.split()[1]
        code, out, err = self.ms("card", i, **self.card_env())
        self.assertEqual(code, 0, err)
        paths = out.split()
        self.assertEqual(len(paths), 1)
        page = self.card_html_of(paths[0])
        self.assertIn("+ quoted original, 1 line", page)
        self.assertNotIn("the original secret line", page)

    def test_wrapping_keeps_every_line_inside_the_text_column(self):
        # Review r1 P2: a 60-character Chinese line is ~970px at 30px; the wrap must split it to fit 586px.
        import importlib.machinery, importlib.util
        loader = importlib.machinery.SourceFileLoader("mailsend_mod", HELPER)
        spec = importlib.util.spec_from_loader("mailsend_mod", loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        text = "这是一个很长的中文句子用于测试换行是否会超出卡片的宽度限制" * 3
        lines = mod.wrap_px(text, mod.BODY_PX, mod.TEXT_W)
        self.assertGreater(len(lines), 3)
        self.assertEqual("".join(lines), text)
        for line in lines:
            self.assertLessEqual(mod.text_w(line, mod.BODY_PX), mod.TEXT_W)
        subj = "x" * 200
        self.assertLessEqual(max(mod.text_w(l, mod.SUBJ_PX) for l in mod.wrap_px(subj, mod.SUBJ_PX, mod.CARD_INNER)),
                             mod.CARD_INNER)

    def test_long_unbroken_subject_grows_the_card(self):
        short_i, _ = self.draft()
        code, out, _ = self.ms("card", short_i, **self.card_env())
        short_h = self.card_h_of(out.strip())
        j = self.ms("draft", "-a", "icloud", "-t", "host@example.com", "-s", "Z" * 220, "--body", "Hi")[1].split()[1]
        code, out, err = self.ms("card", j, **self.card_env())
        self.assertEqual(code, 0, err)
        self.assertGreater(self.card_h_of(out.strip()), short_h)

    def test_long_bodies_paginate_by_rendered_height_not_line_count(self):
        # Review r1 P2: pages are sized by the estimate, so a long CJK body splits instead of running off the card.
        body = "\n".join("这是第%d行的中文内容，用来测试分页是否根据实际高度计算。" % k for k in range(60))
        i, _ = self.draft(body=body)
        code, out, err = self.ms("card", i, **self.card_env())
        self.assertEqual(code, 0, err)
        paths = out.split()
        self.assertGreater(len(paths), 1)
        for p in paths:
            self.assertLessEqual(self.card_h_of(p), 2000)

    def test_real_chrome_card_renders_when_chrome_is_present(self):
        import importlib.util
        lib = os.path.abspath(os.path.join(HERE, "../../local-helpers/libexec/card-preview"))
        spec = importlib.util.spec_from_file_location("cardpreview_test", os.path.join(lib, "cardpreview.py"))
        cp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cp)
        try:
            chrome = cp.chrome()
        except FileNotFoundError as e:
            self.skipTest(str(e))
        i, _ = self.draft("--attach", self.file, body="Real render check: 这是中文和 English 混合的一行。")
        # No renderer override here: the real Chrome path draws the PNG and checks the layout.
        env = {k: v for k, v in self.env.items()}
        env.pop("MAILSEND_CARD_RENDERER", None)
        env["MAILSEND_DRAFT_DIR"] = self.drafts
        env["MAILSEND_CARD_LIB"] = lib
        env["CARD_PREVIEW_CHROME"] = chrome
        r = subprocess.run(["/usr/bin/python3", HELPER, "card", i], env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        png = r.stdout.strip()
        self.assertTrue(os.path.isfile(png))
        self.assertGreater(os.path.getsize(png), 1000)

    def test_legacy_mailsend_can_render_with_new_preview_module(self):
        import importlib.util
        lib = os.path.abspath(os.path.join(HERE, "../../local-helpers/libexec/card-preview"))
        spec = importlib.util.spec_from_file_location("cardpreview_compat_test", os.path.join(lib, "cardpreview.py"))
        cp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cp)
        try:
            chrome = cp.chrome()
        except FileNotFoundError as e:
            self.skipTest(str(e))
        legacy = os.path.join(self.tmp.name, "legacy-mailsend")
        with open(HELPER) as src, open(legacy, "w") as dst:
            dst.write(src.read().replace("cp.chrome()", "cp.CHROME"))
        i, _ = self.draft()
        env = {**self.env, "MAILSEND_CARD_LIB": lib, "CARD_PREVIEW_CHROME": chrome}
        r = subprocess.run(["/usr/bin/python3", legacy, "card", i], env=env,
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertGreater(os.path.getsize(r.stdout.strip()), 1000)
        self.assertEqual(self.calls("send"), [])

    def test_missing_chrome_refuses_to_render_without_sending(self):
        i, _ = self.draft()
        lib = os.path.abspath(os.path.join(HERE, "../../local-helpers/libexec/card-preview"))
        code, _, err = self.ms("card", i, MAILSEND_CARD_LIB=lib)
        self.assertEqual(code, 1)
        self.assertIn("headless Chrome not found", err)
        self.assertEqual(self.calls("send"), [])

    def test_card_writes_a_png_named_for_the_draft_and_sends_nothing(self):
        i, _ = self.draft("--cc", "moni@example.com", "--attach", self.file)
        before = self.state(i)
        code, out, err = self.ms("card", i, **self.card_env())
        self.assertEqual(code, 0, err)
        png = os.path.join(self.drafts, "cards", f"{i}.png")
        self.assertEqual(out.strip(), png)
        self.assertTrue(os.path.isfile(png))
        with open(png + ".html") as fh:
            page = fh.read()
        for want in ("Booking", "icloud@example.com", "host@example.com", "moni@example.com", "menu.pdf", "Can we move it to Friday?",
                     f"draft {i}"):
            self.assertIn(want, page)
        self.assertEqual(self.calls("send"), [])
        self.assertEqual(self.state(i), before)

    def test_card_folds_the_quoted_original_and_splits_long_mail(self):
        code, out, err = self.ms("reply", "-a", "gmail", "-m", "Inbox", "262282", "--body", "Thanks!")
        i = out.split()[1]
        code, out, err = self.ms("card", i, **self.card_env())
        self.assertEqual(code, 0, err)
        with open(os.path.join(self.drafts, "cards", f"{i}.png") + ".html") as fh:
            page = fh.read()
        self.assertIn("+ quoted original, 1 line", page)
        self.assertNotIn("the original secret line", page)
        # A long body (over one card's worth of lines) comes out as card 1 and card 2, both printed.
        long_body = "\n".join(f"line {k}" for k in range(120))
        j, _ = self.draft(body=long_body)
        code, out, err = self.ms("card", j, **self.card_env())
        self.assertEqual(code, 0, err)
        paths = out.split()
        self.assertEqual(len(paths), 3)
        self.assertTrue(paths[1].endswith(f"{j}-2.png"))

    def test_card_refuses_an_unknown_or_bad_id(self):
        code, _, err = self.ms("card", "0123456789", **self.card_env())
        self.assertEqual(code, 2)
        self.assertIn("no pending draft", err)
        code, _, err = self.ms("card", "../../etc", **self.card_env())
        self.assertEqual(code, 2)
        self.assertIn("bad draft id", err)
        i, _ = self.draft()
        self.ms("send", "--approved", i, "--inbound", "X1")
        code, _, err = self.ms("card", i, **self.card_env())
        self.assertEqual(code, 2)
        self.assertIn("no pending draft", err)

    def test_failed_sent_copy_is_only_a_warning(self):
        i, _ = self.draft()
        code, out, err = self.ms("send", "--approved", i, "--inbound", "X1", FAKE_ADD_RC="1")
        self.assertEqual(code, 0)
        self.assertIn("(sent)", out)
        self.assertIn("don't resend", err)
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.sent.json"])


if __name__ == "__main__":
    unittest.main()
