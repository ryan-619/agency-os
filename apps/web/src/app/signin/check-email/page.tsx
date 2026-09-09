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
          Nothing was sent if the address is not on the team — the system will not tell you
          which, and will not create an account.
          <br />
          <br />
          In local development the message is waiting at{' '}
          <a href="http://localhost:8025">localhost:8025</a>.
        </p>
      </div>
    </div>
  )
}
