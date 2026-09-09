export default function CheckEmail() {
  return (
    <div className="auth-wrap">
      <div className="auth">
        <h1>Check your inbox</h1>
        <p>
          If that address belongs to a team member, a sign-in link is on its way. It is valid
          for 15 minutes and can be used once.
        </p>
        <p className="fine">
          You will see this page whether or not the address is on the team, and no account is
          ever created — so this screen reveals nothing about who has access.
          <br />
          <br />
          In local development the message is waiting at{' '}
          <a href="http://localhost:8025">localhost:8025</a>.
        </p>
      </div>
    </div>
  )
}
