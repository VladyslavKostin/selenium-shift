using System;
using OpenQA.Selenium;
using OpenQA.Selenium.Support.UI;

namespace Shop.Tests.Pages
{
    public abstract class BasePage
    {
        protected readonly IWebDriver Driver;
        protected readonly WebDriverWait Wait;

        // Constructor doing element work: cannot become async.
        protected BasePage(IWebDriver driver)
        {
            Driver = driver;
            Wait = new WebDriverWait(driver, TimeSpan.FromSeconds(10));
            Driver.Manage().Timeouts().ImplicitWait = TimeSpan.FromSeconds(5);
        }

        public string PageTitle
        {
            get { return Driver.Title; }
        }

        protected void ClickWhenReady(By locator)
        {
            Wait.Until(d => d.FindElement(locator).Displayed);
            Driver.FindElement(locator).Click();
        }

        public void GoTo(string url)
        {
            Driver.Navigate().GoToUrl(url);
        }
    }
}
