"""Lab bootstrap for PieFed 1.8.11, run inside the piefed-web container.

PieFed has no first-run API: `flask init-db` creates the site and prompts for
the admin on a TTY, and `/api/alpha/user/register` is a stub in 1.8.11. So this
script does what init-db does for users, then applies lab settings. Everything
after it (communities, follows, posts, votes) goes through /api/alpha.

Usage: python /lab/bootstrap.py <allowed-domain> [<allowed-domain> ...]
Idempotent.
"""
import os
import subprocess
import sys
from random import randint

sys.path.insert(0, "/app")

from app import create_app, db  # noqa: E402
from app.activitypub.signature import RsaKeys  # noqa: E402
from app.constants import ROLE_ADMIN  # noqa: E402
from app.models import AllowedInstances, Role, Site, User  # noqa: E402
from app.auth.util import random_token  # noqa: E402
from app.utils import finalize_user_setup, gibberish, set_setting  # noqa: E402

USERS = [("pfadmin", "lab-password-1", True), ("pfuser", "lab-password-1", False)]
AUTHENTICATED_ROLE = 2  # init-db creates roles in a fixed order


def ensure_site_initialised() -> None:
    with create_app().app_context():
        if db.inspect(db.engine).has_table("site") and db.session.get(Site, 1) is not None:
            return
    env = dict(os.environ, FLASK_APP="pyfedi.py")
    subprocess.run(["flask", "init-db", "--interactive", "no"], check=True, cwd="/app", env=env)


def ensure_user(name: str, password: str, admin: bool) -> None:
    user = User.query.filter_by(user_name=name, instance_id=1).first()
    if user is not None:
        return
    private_key, public_key = RsaKeys.generate_keypair()
    user = User(
        user_name=name,
        title=name,
        email=f"{name}@piefed.lab.test",
        verification_token=random_token(16),
        instance_id=1,
        email_unread_sent=False,
        private_key=private_key,
        public_key=public_key,
        alt_user_name=gibberish(randint(8, 20)),
    )
    user.set_password(password)
    user.roles.append(db.session.get(Role, ROLE_ADMIN if admin else AUTHENTICATED_ROLE))
    db.session.add(user)
    db.session.commit()
    finalize_user_setup(user)
    print(f"created {'admin' if admin else 'user'} {name}")


def main(allowed: list[str]) -> None:
    ensure_site_initialised()
    app = create_app()
    with app.app_context():
        site = db.session.get(Site, 1)
        site.name = "PieFed lab"
        site.registration_mode = "Open"
        site.private_instance = False
        site.enable_downvotes = True
        # Keep raw ActivityPub JSON in activitypub_log for captures.
        site.log_activitypub_json = True
        db.session.commit()

        # Federate only with the lab peers (PieFed "allowlist" federation mode).
        set_setting("use_allowlist", True)
        set_setting("captcha_enabled", False)
        for domain in allowed:
            if AllowedInstances.query.filter_by(domain=domain).first() is None:
                db.session.add(AllowedInstances(domain=domain))
        db.session.commit()

        for name, password, admin in USERS:
            ensure_user(name, password, admin)
    print("piefed bootstrap done; allowlist:", ", ".join(allowed))


if __name__ == "__main__":
    main(sys.argv[1:])
