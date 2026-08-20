using System;
using System.Linq;
using System.Collections.Generic;
using OpenQA.Selenium;

namespace Shop.Tests.Pages
{
    public class LoginPage : BasePage, IAuthenticatable
    {
        public LoginPage(IWebDriver driver) : base(driver) { }

        // Property returning an element. Under the locatorSafe rule this stays
        // a synchronous property returning ILocator, and does NOT become async.
        public IWebElement UsernameField => Driver.FindElement(By.Id("username"));
        public IWebElement PasswordField => Driver.FindElement(By.Id("password"));
        public IWebElement SubmitButton => Driver.FindElement(By.CssSelector("button[type=submit]"));

        // Property that performs an action: this one is a genuine blocker.
        public string ErrorMessage
        {
            get { return Driver.FindElement(By.ClassName("error-banner")).Text; }
        }

        public void Login(string user, string password)
        {
            UsernameField.Clear();
            UsernameField.SendKeys(user);
            PasswordField.SendKeys(password);
            SubmitButton.Click();
        }

        public bool IsLoggedIn()
        {
            return Driver.FindElement(By.CssSelector(".account-menu")).Displayed;
        }

        // Iterator: cannot be `async` in the ordinary way.
        public IEnumerable<string> ValidationMessages()
        {
            foreach (var el in Driver.FindElements(By.CssSelector(".field-error")))
            {
                yield return el.Text;
            }
        }
    }
}
