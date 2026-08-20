using System;
using System.Linq;
using System.Collections.Generic;
using OpenQA.Selenium;

namespace Shop.Tests.Pages
{
    public class CartPage : BasePage
    {
        public CartPage(IWebDriver driver) : base(driver) { }

        public IWebElement CheckoutButton => Driver.FindElement(By.Id("checkout"));

        public bool RowIsVisible(int index)
        {
            return Driver.FindElement(By.XPath("//table[@id='cart']//tr[" + index + "]")).Displayed;
        }

        // LINQ predicate calling a member that becomes async: you cannot await
        // inside a Where lambda. This must become an explicit loop.
        public int VisibleRowCount()
        {
            var indexes = Enumerable.Range(1, 20);
            return indexes.Where(i => RowIsVisible(i)).Count();
        }

        public void Checkout()
        {
            CheckoutButton.Click();
            Thread.Sleep(2000);
        }

        public string Total()
        {
            return Driver.FindElement(By.CssSelector(".cart-total")).Text;
        }
    }
}
